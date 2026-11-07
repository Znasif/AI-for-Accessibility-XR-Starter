// Indoor orientation: one app, two presets on the dashboard's Profile card.
//
//   bun run dev     then open http://localhost:3000
//
// Choose the active profile on the dashboard. Its questions drive the prompts.
//
// The mic is off until the button is tapped, so conversations nearby are not
// recorded. After a tap, say one thing:
//
//   Room briefing "Perimeter walk":   "new room", "start perimeter",
//                                     "did I cover the perimeter?"
//   Room briefing "Room layout":      "new room", "stay here",
//                                     "remember this room as kitchen",
//                                     "did the furniture move in the kitchen?"
//   Any profile:                      "say more" after a briefing, or a question.
//
// Tap while the app is talking, thinking or listening: stop it.
// Hold while it is quiet: a quick look ahead.
// The prompts are in src/orientation/playbooks.ts.

import { defineApp, type Glasses, type Photo } from './starter/index.ts';
import { appInstructions, briefPrompt, checksFrames, comparePrompt, detailPrompt, framePrompt, introLine, parseFrameReply, perimeterPrompt, playbookOf, QUICK_LOOK_PROMPT, type Playbook } from './orientation/playbooks.ts';
import { findRoom, saveRoom } from './orientation/rooms.ts';
import { activePerson } from './toolkit/people.ts';

const CHECK_EVERY_MS = 6000; // 10 Gemini calls a minute, inside the spending guard
const ALERT_EVERY_MS = 20_000; // the fewest seconds between alerts that are not urgent
const REFRAME_EVERY_MS = 60_000;
const LISTEN_FOR_MS = 8000; // how long the mic stays on after a tap

const fresh = () => ({
  say: null as ((text: string) => Promise<void>) | null,
  newest: null as Photo | null,
  lastCheck: 0,
  lastAlert: 0,
  lastReframe: 0,
  lastSaid: '',
  previous: '',
  looking: false, // a room scan is running, so frame checks wait
  listening: false, // the mic is on after a tap
  working: 0, // an answer being prepared or spoken
  turn: 0, // goes up when the person stops the app, so an answer on its way is dropped
  walking: false,
  startPhoto: null as Photo | null,
  walked: [] as string[],
  group: false,
  lastBrief: '',
  lastViews: [] as Photo[],
  toldMore: false,
});
let s = fresh();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const playbook = (g: Glasses): Playbook => playbookOf(g.profile.get('orientationPlaybook'));
const instructions = appInstructions();
// With "Adapt to the profile" off, the app ignores the person's questions too.
const entryQuestions = (g: Glasses): string[] => (g.profile.on ? activePerson().entry : []);
const watchQuestions = (g: Glasses): string[] => (g.profile.on ? activePerson().continuous : []);

// Runs one answer. `still()` turns false once the person has stopped the app.
async function answer(work: (still: () => boolean) => Promise<void>): Promise<void> {
  const turn = s.turn;
  const session = s;
  s.working++;
  try {
    await work(() => session === s && turn === s.turn);
  } catch (e) {
    // The phone camera sometimes fails one picture. That is not an app error.
    if (!/camera did not take|no photo arrived/i.test(e instanceof Error ? e.message : String(e))) throw e;
    if (session === s && turn === s.turn) await session.say?.('The camera did not work. Try again.');
  } finally {
    session.working--;
  }
}

// A picture taken after this moment. Inside onSpeech, g.takePhoto() on the live
// camera returns the frame from when the person began to speak, so a scan that
// turns the head reads the newest onFrame picture instead.
async function freshPhoto(g: Glasses): Promise<Photo> {
  const asked = Date.now();
  while (Date.now() - asked < 2500) {
    if (s.newest && s.newest.takenAt >= asked) return s.newest;
    await sleep(100);
  }
  try {
    return await g.takePhoto();
  } catch {
    await sleep(500);
    return g.takePhoto();
  }
}

async function lookAround(g: Glasses, still: () => boolean): Promise<Photo[]> {
  s.looking = true;
  try {
    const photos: Photo[] = [];
    for (const step of ['Turn left.', 'Ahead.', 'Right.']) {
      await g.say(step);
      if (!still()) return [];
      await sleep(800);
      photos.push(await freshPhoto(g));
      if (!still()) return [];
    }
    await g.say('One moment.');
    return photos;
  } finally {
    s.looking = false;
  }
}

const briefRoom = (g: Glasses) =>
  answer(async (still) => {
    const photo = await lookAround(g, still);
    if (!still()) return;
    const brief = await g.ai.ask(briefPrompt(entryQuestions(g)), { photo, instructions, look: false });
    if (!still()) return;
    s.lastBrief = brief;
    s.lastViews = photo;
    s.previous = brief;
    await g.say(s.toldMore ? brief : `${brief} Say more for detail.`);
    s.toldMore = true;
  });

const moreDetail = (g: Glasses) =>
  answer(async (still) => {
    if (!s.lastViews.length) return g.say('Say new room first.');
    const detail = await g.ai.ask(detailPrompt(entryQuestions(g)), { photo: s.lastViews, instructions, look: false });
    if (still()) await g.say(detail);
  });

const compareRoom = (g: Glasses, name: string, summary: string) =>
  answer(async (still) => {
    const photo = await lookAround(g, still);
    if (!still()) return;
    const changes = await g.ai.ask(comparePrompt(name, summary), { photo, instructions, look: false });
    if (still()) await g.say(changes);
  });

const lookNow = (g: Glasses, question: string) =>
  answer(async (still) => {
    const photo = await freshPhoto(g);
    if (!still()) return;
    const seen = await g.ai.ask(question, { photo, instructions, look: false });
    if (still()) await g.say(seen);
  });

const checkPerimeter = (g: Glasses) =>
  answer(async (still) => {
    if (!s.startPhoto) return g.say('Say start perimeter first.');
    const now = await freshPhoto(g);
    if (!still()) return;
    const verdict = await g.ai.ask(perimeterPrompt(s.walked), { photo: [s.startPhoto, now], instructions, look: false });
    if (still()) await g.say(verdict);
  });

async function changeSpeed(g: Glasses, step: number) {
  const now = g.profile.settings.rate;
  const next = Math.round(Math.min(2, Math.max(0.5, now + step)) * 10) / 10;
  await g.profile.set('readAloudRate', next);
  await g.say(next === now ? `That is as ${step < 0 ? 'slow' : 'fast'} as I go.` : `Speed ${next}.`);
}

// One thing said after a tap, or typed.
async function command(text: string, g: Glasses): Promise<void> {
  const plan = playbook(g);

  if (/\b(stop|quiet|enough)\s*[.!]?\s*$/i.test(text) && !/\bperimeter\b/i.test(text)) return g.stopSpeaking();
  if (/\b(slower|slow down)\b/i.test(text)) return changeSpeed(g, -0.1);
  if (/\b(faster|speed up)\b/i.test(text)) return changeSpeed(g, +0.1);
  // The mic can open just after someone starts, so "new room" may arrive as "room".
  if (/\bnew room\b|\bdescribe (the|this) room\b|^\W*room\W*$/i.test(text)) return briefRoom(g);
  if (/\b(say more|tell me more|more detail|details)\b/i.test(text)) return moreDetail(g);

  if (plan === 'perimeter') {
    if (/\b(start|begin)\b.*\bperimeter\b/i.test(text)) {
      return answer(async (still) => {
        const start = await freshPhoto(g);
        if (!still()) return;
        s.startPhoto = start;
        s.walked = [];
        s.previous = '';
        s.walking = true;
        await g.say('Start noted. Walk when ready.');
      });
    }
    if (/\b(stop|end)\b.*\bperimeter\b/i.test(text)) {
      s.walking = false;
      return g.say('Stopped following.');
    }
    if (/\b(cover|covered|back at the start|whole perimeter)\b/i.test(text)) return checkPerimeter(g);
  }

  if (plan === 'layout') {
    if (/\b(stay here|group mode)\b/i.test(text)) {
      s.group = true;
      return g.say('Watching the group.');
    }
    if (/\bleave group\b/i.test(text)) {
      s.group = false;
      return g.say('Stopped watching the group.');
    }
    const remember = /\bremember (?:this (?:room|place) )?as (?:the |a )?(.+?)[.!?]*$/i.exec(text);
    if (remember) {
      if (!s.lastBrief) return g.say('Say new room first.');
      saveRoom(remember[1]!, s.lastBrief);
      return g.say(`Saved as ${remember[1]}.`);
    }
    if (/\b(furniture|moved?|changed?|is this|back in)\b/i.test(text)) {
      const room = findRoom(text);
      if (room) return compareRoom(g, room.name, room.summary);
      if (/\bfurniture\b/i.test(text)) return g.say('Which room? Say its saved name.');
    }
  }

  await answer(async (still) => {
    const reply = await g.ai.chat(text, { instructions });
    if (still()) await g.say(reply);
  });
}

// A tap opens the mic for one thing said, then it closes again.
async function listenOnce(g: Glasses): Promise<void> {
  const session = s;
  const turn = s.turn;
  const still = () => session === s && turn === s.turn;
  let heard: string | null = null;
  s.listening = true;
  try {
    await g.say('Listening.');
    if (!still()) return;
    heard = await g.listen({ timeoutMs: LISTEN_FOR_MS });
  } finally {
    session.listening = false;
  }
  if (!still()) return;
  if (heard) await command(heard, g);
  else await g.say('Mic off.');
}

export default defineApp({
  name: 'Indoor orientation',
  instructions,
  listen: 'when-asked',

  async onStart(g) {
    s = fresh();
    s.say = (text) => g.say(text);
    await g.say(introLine(playbook(g)));
  },

  async onStop() {
    s = fresh(); // nothing about people or this session is kept
  },

  // With the mic off between taps, this is text typed on the dashboard or phone.
  async onSpeech(text, g) {
    await command(text, g);
  },

  // Any press stops the app when it is busy. When it is quiet, a tap listens
  // and a hold takes a quick look.
  async onButton(button, g) {
    if (s.working > 0 || s.listening) {
      s.turn++;
      g.stopSpeaking();
      // Says it stopped, and replaces "Listening." in the captions.
      return g.say('Stopped.');
    }
    if (button.press === 'long') return lookNow(g, QUICK_LOOK_PROMPT);
    await listenOnce(g);
  },

  // Runs for every picture, so a room scan can use the newest one.
  // Each Gemini call is paced by CHECK_EVERY_MS.
  async onFrame(frame, g) {
    s.newest = frame;
    const plan = playbook(g);
    if (s.looking || s.listening || s.working > 0 || !checksFrames(plan, s.walking) || Date.now() - s.lastCheck < CHECK_EVERY_MS) return;
    s.lastCheck = Date.now();

    const session = s;
    const prompt = framePrompt(plan, { previous: s.previous, group: s.group, walked: s.walked }, watchQuestions(g));
    const reply = parseFrameReply(await g.ai.ask(prompt, { photo: frame, json: true, temperature: 0, instructions, look: false }));
    if (!reply || session !== s) return;

    if (reply.state) s.previous = reply.state;
    if (reply.passed && s.walked.at(-1) !== reply.passed) s.walked.push(reply.passed);

    // Something the person asked for came first, unless this cannot wait.
    if ((s.looking || s.working > 0) && !reply.urgent) return;

    const now = Date.now();
    let line = '';
    if (reply.say && (reply.urgent || now - s.lastAlert >= ALERT_EVERY_MS)) {
      line = reply.say;
      s.lastAlert = now;
    } else if (!reply.say && reply.reframe && now - s.lastReframe >= REFRAME_EVERY_MS) {
      line = reply.reframe;
      s.lastReframe = now;
    }
    if (!line || line === s.lastSaid) return;
    s.lastSaid = line;
    if (reply.urgent) {
      s.turn++; // the answer on its way is dropped: this comes first
      g.stopSpeaking();
    }
    await g.say(line);
  },
});
