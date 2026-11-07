// The orientation app's prompts, profile presets, frame replies and saved rooms.
// No Gemini: these check what is sent and how replies are read.

import { beforeEach, describe, expect, test } from 'bun:test';
import { tempDir } from './helpers.ts';
import { config } from '../src/starter/config.ts';
import { appInstructions, briefPrompt, checksFrames, detailPrompt, framePrompt, introLine, parseFrameReply, perimeterPrompt, playbookOf } from '../src/orientation/playbooks.ts';
import { findRoom, loadRooms, saveRoom } from '../src/orientation/rooms.ts';
import { addPerson, activePerson, hasPeopleFile, loadPeople, savePerson, selectPerson, syncActiveNeeds } from '../src/toolkit/people.ts';
import { checkNeedValue, EXAMPLE_PROFILES } from '../src/toolkit/needs.ts';
import { profilePrompt } from '../src/toolkit/prompt.ts';
import { audioSettings } from '../src/toolkit/settings.ts';
import app from '../src/app.ts';

// The same settings the two people's profiles use.
const PRESETS: Record<string, { supportAreas: string[]; needs: Array<{ dimension: string; value: unknown }> }> = {
  'perimeter-left': {
    supportAreas: ['vision'],
    needs: [
      { dimension: 'orientationPlaybook', value: 'perimeter' },
      { dimension: 'directionStyle', value: 'relative' },
      { dimension: 'distanceStyle', value: 'metres' },
      { dimension: 'extraDetailSide', value: 'left' },
    ],
  },
  'layout-clock': {
    supportAreas: ['vision', 'hearing'],
    needs: [
      { dimension: 'orientationPlaybook', value: 'layout' },
      { dimension: 'directionStyle', value: 'clock' },
      { dimension: 'distanceStyle', value: 'metres-comparison' },
    ],
  },
};
const preset = (key: string) => PRESETS[key]!;
const promptFor = (key: string) => {
  const profile = preset(key);
  return profilePrompt(profile, audioSettings(profile));
};

describe('the presets', () => {
  test('every value is one the profile accepts', () => {
    for (const key of ['perimeter-left', 'layout-clock']) {
      for (const n of preset(key).needs) expect(checkNeedValue(n.dimension, n.value).ok).toBe(true);
    }
  });

  test('perimeter walk: left and right, metres, more about the left', () => {
    const text = promptFor('perimeter-left');
    expect(text).toContain('left, right, ahead and behind');
    expect(text).toContain('Give distances in metres');
    expect(text).toContain("on the wearer's left");
    expect(text).not.toContain("o'clock");
  });

  test('room layout: clock positions and familiar comparisons', () => {
    const text = promptFor('layout-clock');
    expect(text).toContain("12 o'clock is straight ahead");
    expect(text).toContain('tennis court');
    expect(text).not.toContain("on the wearer's left");
  });

  test('preferences apply to JSON requests too', () => {
    const profile = preset('layout-clock');
    expect(profilePrompt(profile, audioSettings(profile), { forData: true })).toContain("12 o'clock");
  });

  test('prompts carry no personal details', () => {
    const all = [promptFor('perimeter-left'), promptFor('layout-clock'), briefPrompt([]), appInstructions(), JSON.stringify(EXAMPLE_PROFILES)].join(' ');
    expect(all).not.toMatch(/injury|eye\b/i);
  });
});

describe('the briefings', () => {
  const inOrder = (text: string, parts: string[]) => {
    let at = -1;
    for (const part of parts) {
      const next = text.indexOf(part);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  };

  test("the person's questions are asked in their order", () => {
    inOrder(briefPrompt(['Distance between doors.', 'Obstacles?', 'Empty chairs?']), ['1. Distance between doors.', '2. Obstacles?', '3. Empty chairs?']);
  });

  test('with no questions, a general description', () => {
    expect(briefPrompt([])).toContain('what this place is');
    expect(detailPrompt([])).toContain('what this place is');
  });

  test('a long list of questions gets more room', () => {
    expect(briefPrompt(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain('under 70 words');
  });

  test('every prompt refuses to call a path clear', () => {
    expect(briefPrompt([])).toContain('Never say that a path is clear');
    expect(framePrompt('layout', { previous: '', group: false, walked: [] })).toContain('Never say that a path is clear');
    expect(perimeterPrompt([])).toContain('never say it is certain');
    expect(appInstructions()).toContain('say how to move the camera');
  });

  test('the first thing said states the limits, in few words', () => {
    for (const p of ['general', 'perimeter', 'layout'] as const) {
      expect(introLine(p)).toContain('not a mobility aid');
      expect(introLine(p).split(/\s+/).length).toBeLessThan(25);
    }
  });

  test('the first answer is short, and more detail is a separate request', () => {
    expect(briefPrompt(['a'])).toContain('under 45 words');
    expect(detailPrompt(['a'])).toContain('under 90 words');
  });

  test('alerts leave out things that are simply in the room', () => {
    for (const p of ['perimeter', 'layout'] as const) {
      const text = framePrompt(p, { previous: '', group: false, walked: [] });
      expect(text).toContain('are not news');
      expect(text).toContain('under 8 words');
    }
  });
});

describe('looking at frames', () => {
  test('a profile off or unset falls back to the general playbook', () => {
    expect(playbookOf(undefined)).toBe('general');
    expect(playbookOf('perimeter')).toBe('perimeter');
  });

  test('only spends Gemini calls when the playbook needs them', () => {
    expect(checksFrames('general', true)).toBe(false);
    expect(checksFrames('perimeter', false)).toBe(false);
    expect(checksFrames('perimeter', true)).toBe(true);
    expect(checksFrames('layout', false)).toBe(true);
  });

  test("the person's watch list reaches the prompt", () => {
    expect(framePrompt('layout', { previous: '', group: false, walked: [] }, ['Are there open cabinet doors?'])).toContain('open cabinet doors');
  });

  test('group mode and the landmarks passed reach the prompt', () => {
    expect(framePrompt('layout', { previous: '', group: true, walked: [] })).toContain('people have left');
    expect(framePrompt('layout', { previous: '', group: false, walked: [] })).not.toContain('people have left');
    expect(framePrompt('perimeter', { previous: 'a door', group: false, walked: ['door', 'corner'] })).toContain('door, corner');
  });

  test('replies are read safely', () => {
    expect(parseFrameReply('{"say":" Open cabinet at 2 o\'clock. ","urgent":true,"state":"cabinet"}')).toEqual({ say: "Open cabinet at 2 o'clock.", urgent: true, reframe: '', passed: '', state: 'cabinet' });
    expect(parseFrameReply('not json')).toBeNull();
    expect(parseFrameReply('{"urgent":"yes"}')!.urgent).toBe(false);
  });

  test('the app has the handlers the plan needs', () => {
    expect(typeof app.onFrame).toBe('function');
    expect(typeof app.onButton).toBe('function');
  });
});

describe('tap to talk', () => {
  // A stand-in for the glasses: records what is said and answers g.listen().
  function fakeGlasses(heard: string | null | (() => Promise<string | null>)) {
    const said: string[] = [];
    let listens = 0;
    let stops = 0;
    const g = {
      say: async (text: string) => void said.push(text),
      stopSpeaking: () => void stops++,
      listen: async () => {
        listens++;
        return typeof heard === 'function' ? heard() : heard;
      },
      takePhoto: async () => ({ takenAt: Date.now() }),
      log: () => {},
      profile: { on: false, get: () => undefined, settings: { rate: 1 } },
      ai: { ask: async () => 'A door ahead.', chat: async (text: string) => `Chat: ${text}` },
    };
    return { g: g as any, said, stops: () => stops, listens: () => listens };
  }

  beforeEach(async () => {
    await app.onStart!(fakeGlasses(null).g);
  });

  test('the mic is off until asked', () => {
    expect(app.listen).toBe('when-asked');
  });

  test('a tap listens, then carries out what was said', async () => {
    const f = fakeGlasses('say more');
    await app.onButton!({ press: 'short' }, f.g);
    expect(f.listens()).toBe(1);
    expect(f.said).toEqual(['Listening.', 'Say new room first.']);
  });

  test('anything else said after a tap is a question for the AI', async () => {
    const f = fakeGlasses('what is on the table?');
    await app.onButton!({ press: 'short' }, f.g);
    expect(f.said.at(-1)).toBe('Chat: what is on the table?');
  });

  test('silence after a tap says the mic is off', async () => {
    const f = fakeGlasses(null);
    await app.onButton!({ press: 'short' }, f.g);
    expect(f.said).toEqual(['Listening.', 'Mic off.']);
  });

  test('a second tap while listening drops what comes next', async () => {
    let release: (text: string) => void = () => {};
    const f = fakeGlasses(() => new Promise((r) => (release = r)));
    const first = app.onButton!({ press: 'short' }, f.g);
    await new Promise((r) => setTimeout(r, 5));
    await app.onButton!({ press: 'short' }, f.g);
    expect(f.stops()).toBe(1);
    release('new room');
    await first;
    expect(f.said).toEqual(['Listening.', 'Stopped.']);
  });

  test('"new room" clipped to "room" still briefs the room', async () => {
    const f = fakeGlasses('room.');
    const first = app.onButton!({ press: 'short' }, f.g);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.said).toEqual(['Listening.', 'Turn left.']);
    await app.onButton!({ press: 'short' }, f.g);
    await first;
  });

  test('a hold takes a quick look without opening the mic', async () => {
    const f = fakeGlasses('new room');
    const look = app.onButton!({ press: 'long' }, f.g);
    await look;
    expect(f.listens()).toBe(0);
    expect(f.said).toEqual(['A door ahead.']);
  });

  test('typed text works without a tap', async () => {
    const f = fakeGlasses(null);
    await app.onSpeech!('say more', f.g);
    expect(f.said).toEqual(['Say new room first.']);
  });
});

describe('people', () => {
  beforeEach(() => {
    config.dataDir = tempDir();
  });

  test('with no file, one general person and no file written', () => {
    expect(activePerson().id).toBe('general');
    expect(hasPeopleFile()).toBe(false);
  });

  test('adding, selecting and editing a person', () => {
    expect(addPerson('Ana María')!.id).toBe('ana-mar-a');
    addPerson('Ben');
    expect(activePerson().name).toBe('Ben');
    selectPerson('ana-mar-a');
    savePerson('ana-mar-a', { entry: [' What is here? ', ''], notes: 'A note.' });
    expect(activePerson().entry).toEqual(['What is here?']);
    expect(activePerson().notes).toBe('A note.');
    expect(loadPeople().people.find((p) => p.id === 'ben')!.entry).toEqual([]);
  });

  test('two people with one name stay separate, and an unknown person is refused', () => {
    addPerson('Ben');
    expect(addPerson('Ben')!.id).toBe('ben-2');
    expect(selectPerson('nobody')).toBeNull();
    expect(savePerson('nobody', { notes: 'x' })).toBeNull();
    expect(addPerson('  ')).toBeNull();
  });

  test('profile changes stay with the active person', () => {
    addPerson('Ben');
    syncActiveNeeds({ supportAreas: ['vision'], needs: [{ dimension: 'readAloudRate', value: 1.4, strength: 'preference' }] });
    expect(activePerson().needs).toEqual([{ dimension: 'readAloudRate', value: 1.4 }]);
    expect(activePerson().supportAreas).toEqual(['vision']);
  });

  test('notes never reach a prompt', () => {
    const person = addPerson('Ben')!;
    savePerson(person.id, { entry: ['What is here?'], notes: 'PRIVATE NOTE' });
    const updated = activePerson();
    const all = [briefPrompt(updated.entry), detailPrompt(updated.entry), framePrompt('layout', { previous: '', group: false, walked: [] }, updated.continuous)].join(' ');
    expect(all).toContain('What is here?');
    expect(all).not.toContain('PRIVATE NOTE');
  });
});

describe('saved rooms', () => {
  beforeEach(() => {
    config.dataDir = tempDir();
  });

  test('a room is found by name in what the person says', () => {
    saveRoom('Kitchen', 'A table in the middle.');
    expect(findRoom('did the furniture move in the kitchen?')!.summary).toBe('A table in the middle.');
    expect(findRoom('did the furniture move in the lab?')).toBeUndefined();
  });

  test('saving a name again replaces it', () => {
    saveRoom('lab', 'old');
    saveRoom('LAB', 'new');
    expect(loadRooms()).toHaveLength(1);
    expect(findRoom('the lab')!.summary).toBe('new');
  });

  test('no saved rooms is not an error', () => {
    expect(loadRooms()).toEqual([]);
    expect(findRoom('kitchen')).toBeUndefined();
  });
});
