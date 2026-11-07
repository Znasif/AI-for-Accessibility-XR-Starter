// The API your app uses. The other files in src/starter/ make it work.
//
//   import { defineApp } from './starter/index.ts';
//
//   export default defineApp({
//     name: 'My app',
//     async onSpeech(text, g) {
//       await g.say(`You said ${text}`);
//     },
//   });
//
// `g` is the glasses: the person wearing them, their camera, microphone and
// speaker, and their accessibility profile from the toolkit. The same code
// runs on the real glasses and on the laptop and phone simulators.

import type { AudioSettings } from '../toolkit/settings.ts';
import type { Need } from '../toolkit/profile.ts';
import type { LightColor } from './protocol.ts';

export type { AudioSettings } from '../toolkit/settings.ts';
export type { Need } from '../toolkit/profile.ts';
export type { LightColor } from './protocol.ts';

export interface Photo {
  /** The picture as JPEG bytes. */
  jpeg: Buffer;
  /** The same bytes as base64, for APIs that want text. */
  readonly base64: string;
  /** Where it came from: the glasses camera, or the phone camera when the phone acts as the glasses. 'webcam': a simulator that does not say, such as a test device. */
  from: 'glasses' | 'webcam' | 'phone';
  /** When it arrived (ms since 1970). */
  takenAt: number;
  /** Shown on the dashboard under this id. */
  id: string;
}

export interface AskOptions {
  /** One or more photos for the AI to look at. */
  photo?: Photo | Photo[];
  /** Replaces the app's `instructions` for this one request. */
  instructions?: string;
  /** Ask for JSON. The answer is still a string: JSON.parse it. */
  json?: boolean;
  /** 0 is most predictable. Default 0.3. */
  temperature?: number;
  /**
   * Without a photo, Gemini cannot see. When a question needs the camera,
   * g.ai says "Let me look.", takes a photo and asks again. Default true.
   * With false, the answer says that it needs a photo. JSON requests do not take photos.
   */
  look?: boolean;
}

export interface Glasses {
  /**
   * Speak through the glasses speaker. Resolves when the person has heard it.
   * Adapts to the profile: speed, one step at a time, pauses, captions.
   * Write it the way you would say it: no markdown, no lists.
   */
  say(text: string): Promise<void>;

  /** Stop speaking now. Lines still waiting are dropped too. */
  stopSpeaking(): void;

  /**
   * Take a photo with the glasses camera (the phone camera when the phone acts as the glasses).
   * mode 'text' tunes the camera for reading print.
   * Takes a few seconds, longer when the photo travels over Bluetooth.
   *
   * With the live camera (`camera: 'live'`, or an app with `onFrame`) it
   * returns the newest picture at once. Inside onSpeech, it is the picture
   * from the moment the person began to speak. `size` and `mode` are
   * ignored then: the picture is a 1280×720 video frame.
   */
  takePhoto(opts?: { size?: 'low' | 'medium' | 'high'; mode?: 'photo' | 'text' }): Promise<Photo>;

  /**
   * Wait for the next thing the person says (or types on the dashboard).
   * Resolves with null after `timeoutMs` (default 15 s) of silence.
   * While you wait, what they say comes here and not to onSpeech.
   */
  listen(opts?: { timeoutMs?: number }): Promise<string | null>;

  ai: {
    /** One question to Gemini, with no memory of earlier questions. */
    ask(prompt: string, opts?: AskOptions): Promise<string>;
    /** A conversation: Gemini remembers the earlier turns until Stop. */
    chat(message: string, opts?: AskOptions): Promise<string>;
    /** Forget the conversation so far. */
    forget(): void;
  };

  /** The person's accessibility profile, kept by the toolkit. */
  profile: {
    /** The dashboard's "Adapt to profile" switch. When off, needs is empty and settings are the defaults. */
    readonly on: boolean;
    /** Specific needs, for example { dimension: 'readAloudRate', value: 0.8 }. */
    readonly needs: Need[];
    /** Broad areas: 'vision', 'hearing', 'motor', 'cognitive', 'reading', 'sensory'. */
    readonly supportAreas: string[];
    /** What the profile means for audio: speed, steps, detail, captions. */
    readonly settings: AudioSettings;
    /** The value of one need, or undefined. */
    get(dimension: string): unknown;
    /**
     * Save a need the person asked for ("speak slower"). null removes it.
     * Write what the person said they want. Ask the person first about a
     * need your app guesses.
     */
    set(dimension: string, value: unknown): Promise<void>;
  };

  /** Light the glasses' LED for `seconds` (default 2). null turns it off. */
  light(color: LightColor | null, seconds?: number): void;

  /** Write a line to the dashboard's log. */
  log(...args: unknown[]): void;

  /** Which device is connected right now. 'simulator': the phone acting as the glasses. */
  readonly device: 'glasses' | 'simulator';
}

export interface ButtonPress {
  /** 'short' or 'long' press of the glasses button (or the round button on the phone). */
  press: 'short' | 'long';
}

export interface AppDefinition {
  /** Shown on the dashboard and the phone. */
  name: string;
  /** Who the AI is in this app. Added to g.ai requests. */
  instructions?: string;
  /**
   * 'always' (default): the mic is on while the app is not speaking or
   * busy, and what the person says goes to onSpeech.
   * 'when-asked': the mic turns on for g.listen() and off after it. Good for noisy
   * rooms and for button-first apps.
   */
  listen?: 'always' | 'when-asked';
  /**
   * 'photos' (default): g.takePhoto asks the glasses for a photo each time, a few seconds each.
   * 'live': the glasses stream video to the laptop while the app runs, and
   * g.takePhoto returns the newest picture at once. Needs the glasses on a
   * Wi-Fi network that reaches the laptop, and ffmpeg on the laptop. An app
   * with onFrame uses the live camera too. With the phone as the glasses,
   * photos come from the phone camera, one at a time.
   */
  camera?: 'photos' | 'live';
  /** Start was pressed (on the phone or the dashboard). */
  onStart?(g: Glasses): void | Promise<void>;
  /** The person said something. `text` is already written down. */
  onSpeech?(text: string, g: Glasses): void | Promise<void>;
  /** The person pressed the glasses button. */
  onButton?(button: ButtonPress, g: Glasses): void | Promise<void>;
  /**
   * The live camera's newest picture, about once a second (FRAMES_PER_SECOND
   * in .env). A call that is still running is left to finish; the next
   * picture is skipped. It runs next to onSpeech and onButton. Gemini calls
   * from here count toward the spending guard: ask every few seconds, and
   * compare answers before speaking. With the phone as the glasses, each
   * picture is a photo from the phone camera, so it can arrive less often, and
   * it needs no Wi-Fi to the laptop or ffmpeg. Frames stay off the dashboard's
   * conversation. Pass one to g.ai as usual.
   */
  onFrame?(frame: Photo, g: Glasses): void | Promise<void>;
  /** Stop was pressed. g.say() is silent from now on. */
  onStop?(g: Glasses): void | Promise<void>;
}

/** Wrap your app in this, and export it as the default export. */
export function defineApp(app: AppDefinition): AppDefinition {
  return app;
}
