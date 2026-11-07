# AGENTS.md: notes for coding agents

This repo is a hackathon starter for **Mentra Live** smart glasses (camera,
microphone, speaker, one button, an RGB LED, **no display**). A team writes a
voice app in TypeScript; it runs on their laptop with Bun. A phone app relays
the glasses to the laptop, or acts as the glasses itself ("Use this phone"),
with its camera, mic, speaker and an on-screen button.
The **AI for Accessibility Toolkit** keeps the wearer's accessibility profile,
and the starter adapts speech and AI prompts to it.

Many teams include people with disabilities. Build for the people on the team.

## Where to work

| Path | Touch it? |
|---|---|
| `src/app.ts` | **Yes.** The team's app. Start here. |
| new files under `src/` | Yes. Import them from `src/app.ts`. |
| `examples/*.ts` | Read and copy from. Run with `bun run dev examples/<file>`. |
| `src/toolkit/needs.ts` | Yes, to add a profile need (see below). |
| `src/toolkit/settings.ts`, `src/toolkit/prompt.ts` | When you change how the profile maps to speech and prompts. |
| `src/starter/` | Avoid. It is the tested engine: device link, speech, voice, Gemini, dashboard. Change it when the app needs something the engine lacks, and keep `bun test` passing. |
| `vendor/ai4a11y-toolkit/` | **Do not edit.** A pinned copy of the toolkit package. |
| `phone/` | No. The organiser builds the phone app once for the event. |

## Commands

```bash
bun run dev                       # runs src/app.ts, restarts on save; dashboard at http://localhost:3000
bun run dev examples/1-echo.ts    # run another app file
bun run typecheck                 # tsc --noEmit
bun test                          # offline tests, without Gemini
bun run test:camera               # the live camera, with ffmpeg standing in for the glasses
bun run check                     # setup check; makes 6 small Gemini calls (--offline to skip)
```

Test without glasses: a person runs the app on a phone. In the XR Starter
app, they scan the dashboard's QR code and press **Use this phone**. App code
runs the same way on the glasses and on the phone. With a phone connected,
typing in the dashboard's **Conversation** box works the same as speaking.
Without a phone, Start does nothing, so check changes with `bun test` and
`bun run typecheck`. After editing, check the dashboard log for errors: a
handler that throws shows its error and stack there, and the app says
"Sorry, something went wrong in the app."

## The API (in `src/starter/index.ts`)

```ts
import { defineApp, type Glasses } from './starter/index.ts';

export default defineApp({
  name: 'My app',                       // shown on the dashboard and the phone
  instructions: 'You help people ...',  // added to g.ai requests
  listen: 'always',                     // or 'when-asked': mic on during g.listen()
  async onStart(g) {},                  // Start pressed
  async onSpeech(text, g) {},           // the person said something (already transcribed)
  async onButton({ press }, g) {},      // glasses button: press is 'short' | 'long'
  async onFrame(frame, g) {},           // the newest picture, about once a second (glasses stream or phone camera)
  async onStop(g) {},                   // Stop pressed; g.say is silent now
  camera: 'photos',                     // or 'live': the glasses stream video (see The live camera)
});
```

`g` (type `Glasses`):

- `await g.say(text)` speaks and resolves when finished. Lines queue in order.
  Text is cleaned of markdown. The profile sets speed, and one step at a time
  adds pauses between sentences.
- `g.stopSpeaking()` cuts off the current line and drops queued ones.
- `await g.takePhoto({ size?: 'low'|'medium'|'high', mode?: 'photo'|'text' })`
  returns `{ jpeg: Buffer, base64, from, takenAt, id }`. A few seconds, and
  longer when the photo travels over Bluetooth. Say something first
  ("Let me look.") so the wearer is not left in silence. `mode: 'text'` is
  tuned for print.
  With the live camera it returns a frame at once (below).
- `await g.listen({ timeoutMs? })` returns the next thing said or typed, or
  `null` after the timeout (default 15 s). While it waits, speech goes to it
  and not to `onSpeech`.
- `await g.ai.ask(prompt, { photo?, instructions?, json?, temperature? })`:
  one Gemini request, no memory. With `json: true` the reply is a JSON string;
  `JSON.parse` it.
- `await g.ai.chat(message, { photo? })`: keeps the conversation until Stop or
  `g.ai.forget()`.
- `g.profile.settings` (`rate`, `oneStepAtATime`, `plainLanguage`, `detail`,
  `captions`, `describeImages`, ...), `g.profile.get(dimension)`,
  `g.profile.needs`, `g.profile.supportAreas`, `g.profile.on`,
  `await g.profile.set(dimension, value)`.
- `g.light(color, seconds?)`: color is `'red'|'green'|'blue'|'orange'|'white'` or `null`.
- `g.log(...)` writes to the dashboard log. `g.device` is `'glasses'` or
  `'simulator'` (the phone acting as the glasses).

### How turn-taking works (read before writing handlers)

- The mic is ignored while the app speaks, so it does not hear itself.
- One handler runs at a time for speech. If the person speaks while
  `onSpeech` is still running (and not waiting in `g.listen()`), that speech
  is **dropped** and the dashboard shows "not handled: the app was still
  busy". For a back-and-forth inside one task, loop with `g.listen()` (see
  `examples/4-step-by-step.ts`).
- A button press runs `onButton`, even while another handler runs.
- Stop cancels Gemini requests in flight; `g.say` then stays silent and
  `g.takePhoto` rejects. Handlers do not need to check for this.
- An idle session stops itself after 20 minutes (`IDLE_STOP_MIN`).

### The live camera

By default the glasses take one photo per `g.takePhoto()`. With
`camera: 'live'`, or an `onFrame` handler, the glasses stream video to the
laptop while the app runs (`src/starter/camera.ts`, copied from the AI for
Accessibility XR project, where it ran with these glasses):

- `g.takePhoto()` returns the newest frame at once, 1280×720. Inside
  `onSpeech` it is the frame from when the person began to speak.
- `onFrame(frame, g)` runs about once a second (`FRAMES_PER_SECOND`), with a
  `Photo`. A call still running is left to finish and that frame is skipped.
  It does not block `onSpeech` or `onButton`. Gemini calls from it count
  toward the spending guard: ask every few seconds, and compare answers
  before speaking (see `examples/6-watch-ahead.ts`).
- It needs the glasses on a Wi-Fi network that reaches the laptop (the
  tunnel does not carry video), and ffmpeg on the laptop. Without them the
  dashboard says so, and the app falls back to single photos.
- With the phone as the glasses there is no stream. `onFrame` gets photos from
  the phone camera, one at a time, so they can arrive less often than once a
  second. This needs no Wi-Fi to the laptop and no ffmpeg. `g.takePhoto()` also
  uses the phone camera, and takes its turn after a frame in progress.
- Frames for `onFrame` do not appear in the dashboard's conversation.
- The dashboard's glasses card shows the newest frame while it streams.

### The AI

- The model is Gemini (`GEMINI_MODEL`, default `gemini-3.5-flash`, falls
  back to `gemini-flash-latest`). Requests already tell the model that
  its words are spoken aloud: short, no markdown, no lists.
- When the profile is on, `g.ai` adds the profile's directives (one step at a
  time, plain words, detail level, describe surroundings). With `json: true`,
  `g.ai` adds the wording directives and leaves out the others.
- A spending guard switches Gemini off past 60 calls a minute or 800 a run.
  Each utterance costs one or two calls for speech-to-text, and each spoken
  sentence one call for the voice. Do not call Gemini in a loop without a pause.

## The toolkit and the profile

- The profile is `{ supportAreas: string[], needs: { dimension, value }[] }`,
  stored by the toolkit in `data/`. Edit it on the dashboard under **Profile**.
- `src/toolkit/settings.ts` turns it into `AudioSettings` using the toolkit's
  `renderXRSettings`. Toolkit dimensions used: `readAloudRate`, `simplify`,
  `captions`, `describeImages`. Audio add-ons: `pacing` (`'stepwise'`),
  `spokenDetail` (`'gist'|'standard'|'full'`).
- To add a need: add an entry to `NEEDS` in `src/toolkit/needs.ts` (it then
  appears on the dashboard), and read it with `g.profile.get('yourNeed')`, or
  map it in `settings.ts` / `prompt.ts`.
- The profile belongs to the person. Write with `g.profile.set` what the
  person asked for ("speak slower"). Ask before saving a need the app inferred.
- The dashboard's **Adapt to the profile** switch hides the profile from the
  app (empty needs, default settings) so teams can compare.

## Writing for the ear

- Spoken text: short sentences, one idea each, plain words.
- Make no assumption about what the wearer can see, hear or do. Say where
  things are from the wearer (left, right, ahead, a distance), and leave out
  "you are looking at", "as you can see" and "click". `g.ai` already tells
  Gemini this (`src/starter/ai.ts`).
- Acknowledge at once when something takes time, then answer.
- Tell the wearer what they can say next, in a few words.

## Things that are deliberate

- Single photos, no video stream (simpler and works over Bluetooth).
- The dashboard answers on localhost and refuses other addresses (it shows camera photos).
- The phone app and the simulators speak the same WebSocket protocol
  (`src/starter/protocol.ts`), so app code cannot tell them apart.
- Tests (`test/`) use a fake device over the real server and run without Gemini.
