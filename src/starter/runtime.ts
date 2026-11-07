// The runtime: one connected device, one app, one session from Start to Stop.
//
// Turn-taking, the way the wearable-extension project settled it:
//   the app listens → the person speaks → the words are written down →
//   the app's handler runs (thinking) → it speaks → it listens again.
// The mic is ignored while the app speaks or works, so it does not hear itself
// and one sentence stays one request.
//
// Rules kept from that project:
// - Waits are bounded. Each device request has a timeout, and a device
//   that disconnects fails what it was asked to do.
// - Rejections here are handled. In Bun an unhandled rejection can end
//   the process, which would drop the phone in the middle of a session.
// - A Stop really stops: Gemini calls in flight are cancelled, lines waiting
//   to be spoken are dropped, and a handler that carries on cannot speak.

import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { cancelGemini, geminiCallCount, geminiHaltReason, isMissingKey } from './gemini.ts';
import { createSegmenter } from './speech-in.ts';
import { transcribe } from './speech-in.ts';
import { hasFfmpeg, makeClip, type Clip } from './speech-out.ts';
import { createAi, spoken } from './ai.ts';
import { CAMERA_TIMEOUT_MS, LiveCamera, type CameraState } from './camera.ts';
import { FrameStore } from './frames.ts';
import { audioSettings, chunkText, type AudioSettings } from '../toolkit/settings.ts';
import { profilePrompt } from '../toolkit/prompt.ts';
import { EMPTY_PROFILE, type Profile, type ProfileStore } from '../toolkit/profile.ts';
import type { AppDefinition, Glasses, Photo } from './index.ts';
import {
  CLOSE_REPLACED,
  PHOTO_UPLOAD_PATH,
  type DeviceKind,
  type DeviceState,
  type DownMessage,
  type DownRequest,
  type LightColor,
  type Phase,
  type PhotoSize,
  type UpMessage,
} from './protocol.ts';

export interface GlassesInfo {
  connected: boolean;
  wifi: boolean | null;
  battery: number | null;
}

// One connected device, as the server hands it over.
export interface DeviceLink {
  kind: DeviceKind;
  name: string; // 'Laptop simulator', 'Phone simulator', or the phone's name
  camera: Photo['from'];
  glasses: GlassesInfo | null;
  send(m: DownMessage): void;
  close(code: number, reason: string): void;
}

export interface DashState extends DeviceState {
  file: string;
  device: null | { kind: DeviceKind; name: string; glasses: GlassesInfo | null };
  adapt: boolean;
  micOn: boolean;
  listenMode: 'always' | 'when-asked';
  camera: CameraState; // the live camera (camera.ts)
  gemini: { key: boolean; off: string | null; calls: number; voice: 'gemini' | 'device'; ffmpeg: boolean };
}

export type DashEvent =
  | { type: 'state'; state: DashState }
  | { type: 'you'; text: string; via: 'voice' | 'typed'; at: number; ignored?: string }
  | { type: 'app'; text: string; at: number; voice: 'gemini' | 'device' }
  | { type: 'photo'; id: string; from: Photo['from']; at: number; kb: number }
  | { type: 'button'; press: 'short' | 'long'; at: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string; at: number }
  | { type: 'profile' };

// Gemini TTS takes its style from the prompt (speech-out.ts).
const CALM_STYLE = 'Say the following in a calm, even, warm tone: ';
const DISCONNECT_GRACE_MS = 15_000;
// After a line ends, the mic counts again after this delay. The glasses play
// the end of a line a little after the phone reports it finished (Bluetooth
// audio delay), and the app must not hear its own last words.
const HOLD_OFF_MS = 300;

// A short first piece starts the voice sooner; later ones can be longer.
const FIRST_PIECE_WORDS = 16;
const LATER_PIECE_WORDS = 40;

// Sentences, kept intact and packed: the first piece up to 16 words, the rest up to 40.
function voicePieces(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let words = 0;
  for (const sentence of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/)) {
    const w = sentence.split(' ').length;
    const limit = out.length ? LATER_PIECE_WORDS : FIRST_PIECE_WORDS;
    if (cur.length && words + w > limit) {
      out.push(cur.join(' '));
      cur = [];
      words = 0;
    }
    cur.push(sentence);
    words += w;
  }
  if (cur.length) out.push(cur.join(' '));
  return out.filter(Boolean);
}
const PHOTO_TIMEOUT_MS = 45_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const randomId = (bytes = 9) => randomBytes(bytes).toString('hex');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class StoppedError extends Error {}

class PhotoImpl implements Photo {
  private cached: string | null = null;
  constructor(
    readonly jpeg: Buffer,
    readonly from: Photo['from'],
    readonly id: string,
    readonly takenAt = Date.now(),
  ) {}
  get base64(): string {
    return (this.cached ??= this.jpeg.toString('base64'));
  }
}

export class Runtime {
  // The `g` handed to handlers. A new one at each Start and Stop, so a
  // handler still running from an earlier session cannot speak, listen or
  // take photos in the next one.
  private g: Glasses;
  private device: DeviceLink | null = null;
  private active = false;
  private gen = 0; // changes at each Start and Stop
  private speechGen = 0; // changes at each Stop and stopSpeaking()
  private busy = 0; // handlers of this session still running
  // Who ended the last session. A device that comes back asks to resume;
  // that is honoured after a restart or a lost connection, and refused after a Stop.
  private lastStop: 'never' | 'person' | 'device' | 'other' = 'never';
  // The mic counts again after this time: Bluetooth audio reaches the ear,
  // and the mic reaches us, a little after the player says a line ended.
  private quietUntil = 0;
  private preparing = 0; // lines whose voice is being made
  private speaking = 0; // lines playing on the device
  private transcribing = 0;
  private heard = '';
  private said = '';
  private statusNote = '';

  // The live camera (camera.ts): frames from the glasses while an app with
  // camera: 'live' or onFrame runs. g.takePhoto reads them, and onFrame gets
  // the newest about once a second.
  private frames = new FrameStore(config.frameRingSize);
  private newestFrame: { jpeg: Buffer; at: number } | null = null; // the last frame that arrived, for onFrame
  private cameraNote = ''; // one line about the camera, from camera.ts
  readonly camera = new LiveCamera({
    frames: this.frames,
    glasses: () => (this.device?.kind === 'glasses' ? this.device.glasses : null),
    startStream: (url, video) => this.request((id) => ({ t: 'camera-start', id, url, ...video }), CAMERA_TIMEOUT_MS).then(() => undefined),
    stopStream: () => this.device?.send({ t: 'camera-stop', id: this.nextRequestId++ }),
    setStatus: (text) => {
      this.cameraNote = text;
      this.pushState();
    },
    log: (level, text) => this.log(level, text),
    onFrame: (jpeg) => void (this.newestFrame = { jpeg, at: Date.now() }),
  });
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private frameBusy = false;
  private frameErrors = 0;
  private phoneFrame: Promise<Photo> | null = null; // a picture being taken for onFrame, with the phone as the glasses
  // When the person began to speak, worked out from the utterance's length,
  // and whether the frames are held on that moment for the handler.
  private spokenAt = 0;
  private speechPinned = false;
  private appError: string | null = null;
  private micOn = false;
  private waiters: Array<(text: string | null) => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private early: Promise<string> | null = null;
  private lastActivity = Date.now();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  // Random start: a device can still answer a request from before a restart.
  private nextRequestId = 1 + Math.floor(Math.random() * 1e9);
  private requests = new Map<number, { resolve: (detail?: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingPhotos = new Map<string, { resolve: (jpeg: Buffer) => void; reject: (e: Error) => void }>();
  private clips = new Map<string, Clip>();
  private photos = new Map<string, Photo>();
  private listeners = new Set<(e: DashEvent) => void>();
  private history: DashEvent[] = [];
  private stored: Profile = EMPTY_PROFILE;
  private adapt = true;
  private ai;

  private segmenter = createSegmenter(
    {
      onTentative: (pcm) => {
        if (!this.canHear()) return;
        const early = transcribe(pcm);
        early.catch(() => {}); // handled where it is used (onUtterance)
        this.early = early;
      },
      onTentativeWithdrawn: () => {
        this.early = null;
      },
      onUtterance: (pcm, held) => this.onUtterance(pcm, held),
    },
    { tentativeSilenceMs: 450 },
  );

  constructor(
    readonly app: AppDefinition,
    private readonly store: ProfileStore,
    readonly appFile = 'src/app.ts',
  ) {
    this.ai = createAi({
      appInstructions: app.instructions,
      profilePrompt: (forData) => profilePrompt(this.profile(), this.settings(), { forData }),
      // A question that needs the camera: say so, and take the photo meanwhile.
      look: () => {
        this.log('info', 'g.ai is taking a photo: the question needs the camera');
        void this.say('Let me look.').catch(() => {});
        return this.takePhoto('medium', 'photo');
      },
    });
    this.g = this.makeGlasses(this.gen);
    store.onChange((p) => {
      this.stored = p;
      this.emit({ type: 'profile' });
      this.pushState();
    });
    void store.read().then((p) => (this.stored = p));
    setInterval(() => this.checkIdle(), 30_000).unref();
  }

  // ── profile ────────────────────────────────────────────────────────────────

  private profile(): Profile {
    return this.adapt ? this.stored : EMPTY_PROFILE;
  }

  settings(): AudioSettings {
    return audioSettings(this.profile());
  }

  get adapting(): boolean {
    return this.adapt;
  }

  setAdapt(on: boolean): void {
    this.adapt = on;
    this.log('info', on ? 'Adapting to the profile' : 'Profile switched off: the app now uses the defaults');
    this.emit({ type: 'profile' });
    this.pushState();
  }

  // ── the `g` your app gets ──────────────────────────────────────────────────

  private makeGlasses(gen: number): Glasses {
    const rt = this;
    // false once a newer session has begun: this g then has no effect.
    const live = () => gen === rt.gen;
    const ended = () => Promise.reject(new StoppedError('This session has ended'));
    return {
      say: (text) => (live() ? rt.say(text) : Promise.resolve()),
      stopSpeaking: () => {
        if (live()) rt.stopSpeaking();
      },
      takePhoto: (opts) => (live() ? rt.takePhoto(opts?.size ?? 'medium', opts?.mode ?? 'photo') : ended()),
      listen: (opts) => (live() ? rt.listen(opts?.timeoutMs ?? 15_000) : Promise.resolve(null)),
      ai: {
        ask: (prompt, opts) => (live() ? rt.ai.ask(prompt, opts) : ended()),
        chat: (msg, opts) => (live() ? rt.ai.chat(msg, opts) : ended()),
        forget: () => rt.ai.forget(),
      },
      profile: {
        get on() {
          return rt.adapt;
        },
        get needs() {
          return rt.profile().needs.map((n) => ({ ...n }));
        },
        get supportAreas() {
          return [...rt.profile().supportAreas];
        },
        get settings() {
          return rt.settings();
        },
        get: (dimension) => rt.profile().needs.filter((n) => n.dimension === dimension).at(-1)?.value,
        set: async (dimension, value) => {
          await rt.store.setNeed(dimension, value, rt.app.name);
          rt.log('info', `Profile: ${dimension} = ${JSON.stringify(value)} (saved by the app)`);
        },
      },
      light: (color, seconds = 2) => rt.device?.send({ t: 'light', color, ms: Math.round(Math.min(30, Math.max(0.2, seconds)) * 1000) }),
      log: (...args) => rt.log('info', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
      get device() {
        return rt.device?.kind ?? 'simulator';
      },
    };
  }

  // ── Start / Stop ───────────────────────────────────────────────────────────

  start(): void {
    if (this.active) return;
    if (!this.device) return this.log('warn', 'Connect the phone first: in XR Starter, scan the QR code on the dashboard. Then press Start.');
    this.active = true;
    this.gen++;
    this.g = this.makeGlasses(this.gen);
    this.busy = 0;
    this.appError = null;
    this.lastActivity = Date.now();
    this.ai.forget();
    this.segmenter.reset();
    this.log('info', `Started (${this.device.kind === 'glasses' ? 'real glasses' : this.device.name.toLowerCase()})`);
    if (this.wantsLiveCamera() && this.device.kind === 'glasses') this.camera.on();
    this.startFrames();
    this.updateMic();
    this.pushState();
    if (this.app.onStart) void this.run('onStart', () => this.app.onStart!(this.g));
  }

  // `by`: who ended it. See lastStop.
  stop(reason = 'Stopped', by: 'person' | 'device' | 'other' = 'person'): void {
    if (!this.active) return;
    this.active = false;
    this.lastStop = by;
    this.gen++;
    this.g = this.makeGlasses(this.gen);
    this.busy = 0;
    this.speechGen++;
    cancelGemini('stopped');
    this.early = null;
    this.segmenter.reset();
    for (const w of this.waiters.splice(0)) w(null);
    for (const [, p] of this.pendingPhotos) p.reject(new StoppedError('Stopped'));
    this.pendingPhotos.clear();
    this.camera.off();
    this.stopFrames();
    this.frames.unpin();
    this.speechPinned = false;
    this.device?.send({ t: 'stop-audio' });
    this.device?.send({ t: 'light', color: null, ms: 0 });
    this.updateMic();
    this.log('info', reason);
    this.pushState();
    if (this.app.onStop) void this.run('onStop', () => this.app.onStop!(this.g));
  }

  private checkIdle(): void {
    if (this.active && Date.now() - this.lastActivity > config.idleStopMin * 60_000) {
      this.stop(`Stopped: no activity for ${config.idleStopMin} minutes (IDLE_STOP_MIN)`, 'other');
    }
  }

  // Run one handler. Errors go to the dashboard; run() does not throw.
  private async run(name: string, fn: () => void | Promise<void>): Promise<void> {
    const gen = this.gen;
    this.busy++;
    this.pushState();
    try {
      await fn();
      if (gen === this.gen) this.appError = null; // it works again
    } catch (e) {
      if (gen !== this.gen || e instanceof StoppedError) return; // ended by Stop: this is expected
      if (isMissingKey(e)) {
        this.appError = 'Add GEMINI_API_KEY to .env and restart. Until then speech-to-text and g.ai do not work.';
        this.log('error', `${name}: ${message(e)}`);
      } else {
        this.appError = `Your app's ${name} failed: ${message(e)}`;
        const where = e instanceof Error ? (e.stack ?? '').split('\n').slice(1, 4).join('\n') : '';
        this.log('error', `${name} failed: ${message(e)}${where ? `\n${where}` : ''}`);
      }
      if (this.active && this.device) void this.say('Sorry, something went wrong in the app.').catch(() => {});
    } finally {
      // A handler from an earlier session no longer counts: busy was reset.
      if (gen === this.gen) this.busy--;
      this.pushState();
    }
  }

  // ── hearing ────────────────────────────────────────────────────────────────

  private get listenMode(): 'always' | 'when-asked' {
    return this.app.listen === 'when-asked' ? 'when-asked' : 'always';
  }

  private canHear(): boolean {
    if (!this.active || this.speaking || this.preparing || this.transcribing) return false;
    if (Date.now() < this.quietUntil) return false;
    return this.waiters.length > 0 || (this.listenMode === 'always' && this.busy === 0);
  }

  private updateMic(force = false): void {
    const on = this.active && (this.listenMode === 'always' || this.waiters.length > 0);
    if (on === this.micOn && !force) return;
    this.micOn = on;
    this.device?.send({ t: 'mic', on });
  }

  private onUtterance(pcm: Buffer, held: boolean): void {
    const reuse = held ? this.early : null;
    this.early = null;
    if (!this.canHear()) return;
    // 16 kHz, 16-bit mono: 32 bytes a millisecond, so the length says when it began.
    this.spokenAt = Date.now() - Math.round(pcm.length / 32);
    const gen = this.gen;
    this.transcribing++;
    this.pushState();
    let text = '';
    void (reuse ?? transcribe(pcm))
      .then(
        (t) => void (text = t),
        (e) => {
          if (isMissingKey(e)) this.appError = 'Add GEMINI_API_KEY to .env to use speech. You can still type on the dashboard.';
          this.log('warn', `Could not write down what was said: ${message(e)}`);
        },
      )
      .finally(() => {
        this.transcribing--;
        this.pushState();
        if (text && gen === this.gen) this.hear(text, 'voice');
      });
  }

  private hear(text: string, via: 'voice' | 'typed'): void {
    this.lastActivity = Date.now();
    this.heard = text;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.emit({ type: 'you', text, via, at: Date.now() });
      waiter(text);
      this.updateMic();
      return this.pushState();
    }
    const ignored =
      !this.active ? 'press Start first'
      : this.busy > 0 ? 'the app was still busy with the last thing'
      : !this.app.onSpeech ? 'this app has no onSpeech'
      : undefined;
    this.emit({ type: 'you', text, via, at: Date.now(), ignored });
    this.pushState();
    if (ignored) return;
    // With the live camera, the handler's g.takePhoto() is the view from when
    // the person began to speak, the way the wearable-extension project did
    // it (frames.ts, pin): by the time Gemini is asked, they have often
    // looked away, at their phone or at the floor.
    const pin = via === 'voice' && this.camera.streaming();
    if (pin) {
      this.frames.pin(this.spokenAt + config.frameLagMs);
      this.speechPinned = true;
    }
    void this.run('onSpeech', () => this.app.onSpeech!(text, this.g)).finally(() => {
      if (pin) {
        this.frames.unpin();
        this.speechPinned = false;
      }
    });
  }

  private listen(timeoutMs: number): Promise<string | null> {
    if (!this.active) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (text: string | null): void => {
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
        this.updateMic();
        this.pushState();
      }, timeoutMs);
      this.waiters.push(waiter);
      this.updateMic();
      this.pushState();
    });
  }

  // ── speaking ───────────────────────────────────────────────────────────────

  say(text: string): Promise<void> {
    const line = spoken(String(text ?? ''));
    if (!line) return Promise.resolve();
    if (!this.active) {
      this.log('info', `say() skipped, the app is stopped: "${short(line)}"`);
      return Promise.resolve();
    }
    const s = this.settings();
    const style = s.calmVoice ? CALM_STYLE : '';
    // Gemini's voice takes a few seconds to make each piece. Cut at
    // sentence ends: a short first piece starts sooner, and the next pieces
    // are made while it plays. Two are made ahead at a time, so reading a long
    // page aloud stays well inside the spending guard. One step at a time
    // pauses between its pieces; otherwise they play back to back.
    const pieces = s.maxWordsPerChunk != null ? chunkText(line, s.maxWordsPerChunk) : voicePieces(line);
    const makeAhead = (from: number) => {
      for (let j = from; j < Math.min(pieces.length, from + 3); j++) void makeClip(pieces[j]!, style);
    };
    makeAhead(0);
    const speechGen = this.speechGen;
    const job = this.queue.then(async () => {
      for (let i = 0; i < pieces.length; i++) {
        if (speechGen !== this.speechGen || !this.active) return;
        makeAhead(i);
        await this.playLine(pieces[i]!, style, s.rate, speechGen);
        if (i < pieces.length - 1 && s.pauseMs > 0) await sleep(s.pauseMs);
      }
    });
    this.queue = job.catch(() => {});
    return job.catch((e) => this.log('warn', `A line was not spoken: ${message(e)}`));
  }

  stopSpeaking(): void {
    this.speechGen++;
    this.device?.send({ t: 'stop-audio' });
  }

  private async playLine(text: string, style: string, rate: number, speechGen: number): Promise<void> {
    this.preparing++;
    this.segmenter.reset();
    this.pushState();
    let clip: Clip | null = null;
    try {
      clip = await Promise.race([makeClip(text, style), sleep(config.ttsDeadlineMs).then(() => null)]);
    } finally {
      this.preparing--;
    }
    if (speechGen !== this.speechGen || !this.active) return this.pushState();
    const link = this.device;
    if (!link) {
      this.log('warn', `No device connected, so this line was not heard: "${short(text)}"`);
      return this.pushState();
    }
    const audioPath = clip ? this.addClip(clip) : null;
    this.said = text;
    this.emit({ type: 'app', text, at: Date.now(), voice: clip ? 'gemini' : 'device' });
    this.speaking++;
    this.segmenter.reset();
    this.pushState();
    // Long enough for the line at this speed, plus room for the download.
    const expectMs = ((clip ? clip.seconds : text.split(/\s+/).length / 2.5) / rate) * 1000;
    try {
      await this.request((id) => ({ t: 'speak', id, text, audioPath, rate }), expectMs + 15_000);
    } catch (e) {
      this.log('warn', `The device did not finish a line: ${message(e)}`);
    } finally {
      this.speaking--;
      this.quietUntil = Date.now() + HOLD_OFF_MS;
      setTimeout(() => this.pushState(), HOLD_OFF_MS + 10); // then show "Listening"
      this.segmenter.reset();
      this.pushState();
    }
  }

  private addClip(clip: Clip): string {
    const id = randomId();
    this.clips.set(id, clip);
    setTimeout(() => this.clips.delete(id), 120_000).unref();
    return `/audio/${id}.${clip.ext}`;
  }

  clip(id: string): Clip | undefined {
    return this.clips.get(id);
  }

  // ── the camera ─────────────────────────────────────────────────────────────

  // `forFrame`: a picture for onFrame. It stays out of the dashboard's conversation.
  private async takePhoto(size: PhotoSize, mode: 'photo' | 'text', forFrame = false): Promise<Photo> {
    const link = this.device;
    if (!link) throw new Error('No device is connected, so there is no camera to use.');
    if (link.kind === 'glasses' && link.glasses && !link.glasses.connected) {
      throw new Error('The phone is connected but the glasses are not. Connect them in the phone app.');
    }
    if (!this.active) throw new StoppedError('Stopped');
    // The live camera: a frame, with no round trip to the glasses. Inside
    // onSpeech it is the view from when the person began to speak; otherwise
    // the next frame to arrive, so a button press gets the view right now.
    if (this.camera.streaming()) {
      const entry = this.speechPinned ? this.frames.recent()[0] : (await this.frames.captureNext(1, 2500)).at(-1);
      if (!this.active) throw new StoppedError('Stopped');
      if (!entry) throw new Error('The live camera has no picture yet. Check that the glasses and this laptop are on the same Wi-Fi.');
      const photo = new PhotoImpl(entry.jpeg, 'glasses', randomId(6), entry.timestamp);
      this.keepPhoto(photo);
      return photo;
    }
    // A phone camera takes one picture at a time, so wait for a frame in progress.
    if (!forFrame && this.phoneFrame) {
      await this.phoneFrame.catch(() => {});
      if (!this.active) throw new StoppedError('Stopped');
    }
    const requestId = `p${randomId()}`;
    const arrived = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPhotos.delete(requestId);
        reject(new Error(`No photo arrived within ${PHOTO_TIMEOUT_MS / 1000} s.`));
      }, PHOTO_TIMEOUT_MS);
      this.pendingPhotos.set(requestId, {
        resolve: (jpeg) => (clearTimeout(timer), resolve(jpeg)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
    const fail = (why: string): void => {
      const p = this.pendingPhotos.get(requestId);
      this.pendingPhotos.delete(requestId);
      p?.reject(new Error(why));
    };
    if (!forFrame) {
      this.statusNote = 'Taking a photo';
      this.pushState();
    }
    void this.request((id) => ({ t: 'photo', id, requestId, uploadPath: PHOTO_UPLOAD_PATH, size, mode, transfer: config.photoTransfer }), PHOTO_TIMEOUT_MS + 5000).then(
      // The device says it was delivered. It is normally here already.
      () => void setTimeout(() => fail('The phone said the photo was sent, but it did not reach this laptop. Check the address the phone uses (PUBLIC_URL).'), 8000),
      (e) => fail(`The camera did not take the photo: ${message(e)}`),
    );
    try {
      const jpeg = await arrived;
      const photo = new PhotoImpl(jpeg, link.camera, randomId(6));
      if (!forFrame) this.keepPhoto(photo);
      return photo;
    } finally {
      if (!forFrame) {
        this.statusNote = '';
        this.pushState();
      }
    }
  }

  // Kept for the dashboard (/api/photo/<id>.jpg), the last 30.
  private keepPhoto(photo: PhotoImpl): void {
    this.photos.set(photo.id, photo);
    for (const old of [...this.photos.keys()].slice(0, -30)) this.photos.delete(old);
    this.emit({ type: 'photo', id: photo.id, from: photo.from, at: photo.takenAt, kb: Math.round(photo.jpeg.length / 1024) });
  }

  // An upload reached /upload/photo. false: no request was waiting for it.
  photoArrived(requestId: string, jpeg: Buffer): boolean {
    const p = this.pendingPhotos.get(requestId);
    if (!p) return false;
    this.pendingPhotos.delete(requestId);
    p.resolve(jpeg);
    return true;
  }

  photo(id: string): Photo | undefined {
    return this.photos.get(id);
  }

  // ── the live camera ────────────────────────────────────────────────────────

  private wantsLiveCamera(): boolean {
    return this.app.camera === 'live' || !!this.app.onFrame;
  }

  // The newest frame, for the dashboard's live view. null when the camera is off or has stalled.
  latestFrame(): Buffer | null {
    return this.camera.streaming() ? this.frames.latest() : null;
  }

  // onFrame, about once a second, with the newest frame. A call that is still
  // running is left to finish, and that tick is skipped. It runs next to the
  // other handlers and does not count as busy, so speech is still heard.
  // With the phone as the glasses there is no stream, so each frame is a photo
  // from the phone camera, and the time a photo takes can lower the rate.
  private startFrames(): void {
    if (!this.app.onFrame || this.frameTimer) return;
    this.frameErrors = 0;
    this.frameTimer = setInterval(() => this.tickFrame(), Math.round(1000 / config.framesPerSecond));
  }

  private stopFrames(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.newestFrame = null;
  }

  private tickFrame(): void {
    if (this.device?.kind === 'simulator') return this.tickPhoneFrame();
    const newest = this.newestFrame;
    if (!this.active || this.frameBusy || !newest || !this.camera.streaming() || this.frames.stalled()) return;
    this.deliverFrame(Promise.resolve(new PhotoImpl(newest.jpeg, 'glasses', randomId(6), newest.at)));
  }

  private tickPhoneFrame(): void {
    // A photo the app asked for goes first: the phone camera takes one at a time.
    if (!this.active || this.frameBusy || this.pendingPhotos.size) return;
    const capture = this.takePhoto('low', 'photo', true);
    this.phoneFrame = capture;
    const done = (): void => {
      if (this.phoneFrame === capture) this.phoneFrame = null;
    };
    capture.then(done, done);
    this.deliverFrame(capture);
  }

  private deliverFrame(next: Promise<Photo>): void {
    const gen = this.gen;
    this.frameBusy = true;
    next
      .then((frame) => (gen === this.gen ? this.app.onFrame!(frame, this.g) : undefined))
      .catch((e) => {
        if (gen !== this.gen || e instanceof StoppedError) return;
        // Once a second would flood the log when it keeps failing: the first few, then one a minute.
        this.frameErrors++;
        if (this.frameErrors <= 3 || this.frameErrors % 60 === 0) this.log('error', `onFrame failed: ${message(e)}`);
      })
      .finally(() => void (this.frameBusy = false));
  }

  // The server is shutting down.
  shutdown(): void {
    this.stopFrames();
    this.camera.dispose();
  }

  // ── the device ─────────────────────────────────────────────────────────────

  private request(make: (id: number) => DownRequest, timeoutMs: number): Promise<string | undefined> {
    const link = this.device;
    if (!link) return Promise.reject(new Error('no device connected'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`the device did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      link.send(make(id));
    });
  }

  attach(link: DeviceLink, resume: boolean): void {
    const old = this.device;
    if (old && old !== link) {
      this.camera.off(); // the old phone is told to stop the stream, before it goes
      old.close(CLOSE_REPLACED, 'another device took over');
      this.dropRequests('another device took over');
    }
    this.device = link;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    link.send({ t: 'welcome', app: this.app.name });
    this.log('info', `Connected: ${link.kind === 'glasses' ? `phone with the glasses (${link.name})` : link.name.toLowerCase()}`);
    if (this.active && this.wantsLiveCamera() && link.kind === 'glasses') this.camera.on();
    this.updateMic(true);
    this.pushState();
    if (!this.active && resume && (this.lastStop === 'never' || this.lastStop === 'device')) this.start();
  }

  detach(link: DeviceLink): void {
    if (this.device !== link) return;
    this.device = null;
    this.dropRequests('the device disconnected');
    this.log('warn', `Disconnected: ${link.kind === 'glasses' ? 'the phone' : `the ${link.name.toLowerCase()}`}`);
    if (this.active) {
      this.graceTimer = setTimeout(() => this.stop('Stopped: the device did not come back', 'device'), DISCONNECT_GRACE_MS);
    }
    this.pushState();
  }

  private dropRequests(why: string): void {
    for (const [, r] of this.requests) {
      clearTimeout(r.timer);
      r.reject(new Error(why));
    }
    this.requests.clear();
  }

  onMessage(link: DeviceLink, m: UpMessage): void {
    if (link !== this.device) return;
    switch (m.t) {
      case 'glasses':
        link.glasses = { connected: !!m.connected, wifi: m.wifi ?? null, battery: m.battery ?? null };
        this.camera.glassesChanged();
        return this.pushState();
      case 'camera-status':
        return this.log(/error|fail/i.test(String(m.status)) ? 'warn' : 'info', `Camera: the glasses report ${String(m.status)}${m.detail ? ` (${String(m.detail).slice(0, 200)})` : ''}`);
      case 'active':
        return m.on ? this.start() : this.stop();
      case 'type':
        if (typeof m.text === 'string' && m.text.trim()) this.hear(m.text.trim(), 'typed');
        return;
      case 'button':
        return this.button(m.press === 'long' ? 'long' : 'short');
      case 'talk-end':
        return this.segmenter.flush();
      case 'reply': {
        const r = this.requests.get(m.id);
        if (!r) return;
        this.requests.delete(m.id);
        clearTimeout(r.timer);
        if (m.ok) r.resolve(m.detail);
        else r.reject(new Error(m.detail || 'the device reported a failure'));
        return;
      }
    }
  }

  onAudio(link: DeviceLink, pcm: Buffer): void {
    if (link !== this.device || !this.active) return;
    if (this.canHear()) this.segmenter.push(pcm);
    else this.segmenter.reset();
  }

  // From the dashboard: typed text, and the simulated button.
  type(text: string): void {
    if (text.trim()) this.hear(text.trim(), 'typed');
  }

  button(press: 'short' | 'long'): void {
    this.lastActivity = Date.now();
    this.emit({ type: 'button', press, at: Date.now() });
    if (!this.active) return this.log('info', 'Button pressed while stopped. Press Start first.');
    if (!this.app.onButton) return this.log('info', 'Button pressed. This app has no onButton.');
    void this.run('onButton', () => this.app.onButton!({ press }, this.g));
  }

  // ── what the device and the dashboard see ──────────────────────────────────

  private phase(): Phase {
    if (!this.active) return 'off';
    // Until the hold-off has passed the mic does not count, so do not say "Listening" yet.
    if (this.speaking || Date.now() < this.quietUntil) return 'speaking';
    if (this.waiters.length && !this.preparing && !this.transcribing) return 'listening';
    if (this.busy || this.preparing || this.transcribing) return 'thinking';
    // listen: 'when-asked' between questions: running, with the mic off.
    return this.micOn ? 'listening' : 'idle';
  }

  // The most urgent first: an error in the app just now, then Gemini being off.
  private problem(): string | null {
    if (this.appError) return this.appError;
    const off = geminiHaltReason();
    if (off) return `Gemini is switched off: ${off}. Restart the server to turn it back on.`;
    if (!config.geminiApiKey) return 'GEMINI_API_KEY is missing from .env, so speech-to-text and g.ai do not work. Typing on the dashboard still works.';
    if (this.active && this.camera.state === 'failed' && this.cameraNote) return this.cameraNote;
    return null;
  }

  private status(phase: Phase): string {
    if (this.statusNote) return this.statusNote;
    if (this.active && this.camera.state === 'starting' && this.cameraNote) return this.cameraNote;
    if (!this.device) return 'No device connected';
    if (phase === 'off') return 'Press Start to begin';
    if (phase === 'listening') return this.waiters.length ? 'Listening for your answer' : 'Listening';
    if (phase === 'idle') return 'Ready. The mic is off until the app asks';
    if (phase === 'thinking') return this.transcribing ? 'Writing down what you said' : 'Working on it';
    return 'Speaking';
  }

  dashState(): DashState {
    const phase = this.phase();
    return {
      app: this.app.name,
      active: this.active,
      phase,
      heard: this.heard,
      said: this.said,
      status: this.status(phase),
      captions: this.settings().captions,
      problem: this.problem(),
      file: this.appFile,
      device: this.device ? { kind: this.device.kind, name: this.device.name, glasses: this.device.glasses } : null,
      adapt: this.adapt,
      micOn: this.micOn,
      listenMode: this.listenMode,
      camera: this.camera.state,
      gemini: { key: !!config.geminiApiKey, off: geminiHaltReason(), calls: geminiCallCount(), voice: config.voice, ffmpeg: hasFfmpeg },
    };
  }

  private lastPushed = '';
  pushState(): void {
    const full = this.dashState();
    const { file: _f, device: _d, adapt: _a, micOn: _m, listenMode: _l, camera: _c, gemini: _g, ...forDevice } = full;
    const key = JSON.stringify(full);
    if (key === this.lastPushed) return;
    this.lastPushed = key;
    this.device?.send({ t: 'state', state: forDevice });
    this.emit({ type: 'state', state: full });
  }

  // ── dashboard events ───────────────────────────────────────────────────────

  log(level: 'info' | 'warn' | 'error', text: string): void {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[app] ${text}`);
    this.emit({ type: 'log', level, text, at: Date.now() });
  }

  private emit(e: DashEvent): void {
    if (e.type !== 'state') {
      this.history.push(e);
      if (this.history.length > 300) this.history.shift();
    }
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a closed dashboard tab */
      }
    }
  }

  subscribe(fn: (e: DashEvent) => void): () => void {
    for (const e of this.history) fn(e);
    fn({ type: 'state', state: this.dashState() });
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
