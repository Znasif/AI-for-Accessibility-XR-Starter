// Watch ahead: an app on the live camera.
//
// With camera: 'live', the glasses stream video to the laptop while the app
// runs, and onFrame gets the newest picture about once a second. Every eight
// seconds this app asks Gemini what the main thing ahead is, in a few words,
// and says it when it changes. The button describes the view in full, at
// once: with the live camera, g.takePhoto() returns the newest picture
// without waiting for the glasses.
//
// The glasses need a Wi-Fi network that reaches the laptop, and ffmpeg on the
// laptop. With the phone as the glasses, onFrame and the button use photos from
// the phone camera, and neither is needed.
//
// Shows: camera: 'live', onFrame, pacing Gemini calls, g.takePhoto with the live camera

import { defineApp } from '../src/starter/index.ts';

// One Gemini call every eight seconds stays well inside the spending guard
// (60 calls a minute), with room for the button and the voice.
const ASK_EVERY_MS = 8000;
let lastAsked = 0;
let lastSeen = '';

export default defineApp({
  name: 'Watch ahead',
  instructions: 'You watch the way ahead for the wearer and name the main thing there.',
  camera: 'live',
  // The mic stays off: this app watches, and answers the button.
  listen: 'when-asked',

  async onStart(g) {
    lastAsked = 0;
    lastSeen = '';
    await g.say('Watching ahead. I will say when the view changes. Press the button for a full description.');
  },

  async onFrame(frame, g) {
    if (Date.now() - lastAsked < ASK_EVERY_MS) return;
    lastAsked = Date.now();
    const seen = (await g.ai.ask('Name the main thing ahead of the wearer, in at most five words. Say "nothing new" when the view is empty.', { photo: frame, temperature: 0 }))
      .toLowerCase()
      .replace(/\.$/, '');
    if (seen === lastSeen || seen.includes('nothing new')) return;
    lastSeen = seen;
    await g.say(seen);
  },

  async onButton(button, g) {
    if (button.press === 'long') return g.stopSpeaking();
    const photo = await g.takePhoto(); // the newest picture, at once
    await g.say(await g.ai.ask('Describe what is ahead, in two sentences.', { photo }));
  },
});
