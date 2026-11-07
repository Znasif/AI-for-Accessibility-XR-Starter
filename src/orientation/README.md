# Indoor orientation app: where everything goes

This guide says where each answer from the workshop handouts goes in the code,
and where the orientation data lives.

**Status:** a first version is built, and it is simpler than the plan below. It
works from what the camera sees, with no setup interview or pre-filled room file.
The prompts are in `playbooks.ts`, saved rooms in `rooms.ts`, the handlers in
`src/app.ts`. Each person's questions and settings are in
`data/orientation/people.json`, which stays out of git, and are edited under
**Profile** on the dashboard (`src/toolkit/people.ts`). The mic is off until the
button is tapped (`listen: 'when-asked'`), so conversations nearby are not
recorded. That leaves out telling where someone speaking is, which would need the
mic on all the time. Files marked *(new)* below
that do not exist yet are still only ideas, and that code has not been run.

## The short version

| What you have | Where it goes |
|---|---|
| How the person wants things said: o'clock or cardinal, units, speed | Toolkit profile: `src/toolkit/needs.ts` |
| How those preferences change the AI's wording | `src/toolkit/prompt.ts` |
| Setup FAQ answers about the space, plus room size, shape, furniture and layout | `data/orientation/room.json` *(new)* |
| Obstacles, signs, people and activity seen while the app runs | `data/orientation/memory.json` and an in-memory list *(new)* |
| What the agent is and how it behaves | `src/orientation/prompt.ts` *(new)* |
| "Always ask me before..." | `src/orientation/policy.ts` *(new)* |
| Speech, button and camera behaviour | `src/app.ts` |
| Persona, gap sentence, success sentence, roles | [Design record](#design-record), below |

### Why the room is not in the toolkit profile

The profile holds what a person wants, and it follows them between apps. A room
is a fact about a place, so it gets its own file. To the wearer, both can still
feel like "my setup".

- The dashboard can only edit toggles, choices and ranges (`NeedKind` in
  `needs.ts`), so it has no way to show a room layout.
- The dashboard's **Adapt to the profile** switch hides needs. It should not
  hide the room.
- `data/` is ignored by git, so a real room layout stays on the laptop.

## Files to create

```text
src/app.ts                     the handlers; keep it short and call into the files below
src/orientation/
  types.ts                     Room, RoomItem and Memory types
  room.ts                      load, check and save room.json
  room.example.json            a made-up room that is safe to commit
  setup.ts                     the one-time FAQ, asked aloud with g.listen()
  memory.ts                    add, expire and look up what the app has seen
  observe.ts                   photo in, JSON observations out, saved to memory
  prompt.ts                    room + memory + rules = the instructions for g.ai
  policy.ts                    the "always ask me before" list and confirm()
test/orientation.test.ts       memory expiry, prompt building, confirm()
data/orientation/              real data, created when the app runs; not in git
```

The team's work stays in `src/app.ts`, `src/orientation/` and `src/toolkit/`.
Leave `src/starter/` alone unless the app needs something the engine lacks.

## Preferences: `src/toolkit/needs.ts`

Add one entry to `NEEDS` for each preference. It then appears on the dashboard,
and the app reads it with `g.profile.get('directionStyle')`.

```ts
{
  key: 'directionStyle',
  label: 'Directions',
  help: 'How the app says where things are.',
  kind: 'choice',
  options: [
    { value: 'clock', label: "O'clock" },
    { value: 'cardinal', label: 'North, south, east, west' },
    { value: 'relative', label: 'Left, right, ahead' },
  ],
  default: 'relative',
  fromToolkit: false,
},
```

Add `distanceUnit` (steps, feet or metres) the same way. Then add matching lines
to `profilePrompt` in `src/toolkit/prompt.ts`, outside the
`s.oneStepAtATime && !opts.forData` block so JSON requests get them too:

```ts
if (profile.needs.some((n) => n.dimension === 'directionStyle' && n.value === 'clock')) {
  lines.push("Give directions as clock positions from the wearer: 12 o'clock is straight ahead. Use this in place of left and right.");
}
```

`src/starter/ai.ts` already tells the model to use "ahead, left, right", so
check on the phone that real answers follow your line.

**Toolkit vocabulary you can already use:** `readAloudRate`, `pacing`,
`spokenDetail`, `simplify`, `captions` and `describeImages`. Save a persona as a
starting point in `EXAMPLE_PROFILES`, named for what it does, never a diagnosis.

## The room: `data/orientation/room.json`

Start from a copy of `room.example.json`, or let `setup.ts` create it.

```json
{
  "name": "Workshop room",
  "shape": "rectangle",
  "size": { "widthM": 8, "depthM": 6 },
  "anchor": { "name": "main door", "facing": "just inside the door, facing into the room" },
  "north": "the wall opposite the main door",
  "items": [
    {
      "id": "long-table",
      "kind": "furniture",
      "name": "long table",
      "at": { "clock": 2, "metres": 3 },
      "surface": "on-entry",
      "note": "Chairs on both long sides."
    },
    {
      "id": "fire-exit",
      "kind": "exit",
      "name": "fire exit",
      "at": { "clock": 10, "metres": 7 },
      "surface": "on-entry"
    },
    {
      "id": "printer",
      "kind": "furniture",
      "name": "printer",
      "at": { "clock": 4, "metres": 5 },
      "surface": "on-ask"
    }
  ],
  "faq": [
    { "q": "Where are the restrooms?", "a": "Out the main door, then second door on the right." }
  ],
  "expected": [
    { "what": "Coffee queue along the back wall", "when": "10:30 to 11:00" }
  ]
}
```

| Field | Meaning |
|---|---|
| `anchor` | The one known position and facing. Every `at` is measured from here. |
| `north` | Where "north" is in this room, if the person wants cardinal directions. |
| `surface` | When the app brings it up: `on-entry` in the opening overview, `on-ask` only when asked, `when-seen` when the camera finds it. |
| `faq` | The setup answers. Put them into the prompt so the app answers from them. |
| `expected` | Known activity in this room, with times. |

### One-time setup: `setup.ts`

In `onStart`: if `room.json` is missing, run the setup, otherwise give the
overview. Ask one question at a time in a `g.listen()` loop (copy
`examples/4-step-by-step.ts`), read each answer back, and save only after the
person confirms. Add a spoken "set up the room again" command. Someone may also
prefer to fill in the file by hand and skip the questions.

## Memory: what the app learns while running

| Kind | Stored in | Kept for (starting point) | What the app says |
|---|---|---|---|
| Sign | `memory.json` | Until seen to change | The sign's wording and where it is |
| Obstacle | `memory.json` | 30 minutes, reset when seen again | Always its age: "A cart was by the door 10 minutes ago." |
| Activity | `memory.json` | 30 minutes, or the time in `expected` | Its age, and that it may be over |
| Person | In-memory list only | Until Stop, never written to disk | Position only, for example "someone at 2 o'clock" |

```ts
type Memory = {
  kind: 'sign' | 'obstacle' | 'activity' | 'person';
  text: string;                  // 'wet floor sign'
  near?: string;                 // a room item id, or a position in words
  firstSeen: number;
  lastSeen: number;
  expires?: number;
};
```

**People:** no names unless the person gives them, and no identifying anyone from
their face. Bystanders have not agreed to be remembered.

**Getting observations:** `observe.ts` calls
`g.ai.ask(prompt, { photo, json: true, temperature: 0 })`, runs `JSON.parse` on
the reply, and saves the result. JSON requests never take their own photo, so
always pass one.

**Feeding it to the AI:** the `instructions` option replaces the app's
instructions for that request, so include everything each time:

```ts
const answer = await g.ai.chat(text, { instructions: orientationPrompt(room, memory.current()) });
```

Tell the model to answer about the room only from this data, to say when
something was last seen, and to say so when it does not know.

## Handlers: `src/app.ts`

| Handler | Job |
|---|---|
| `onStart` | Run setup if needed. Otherwise say the `on-entry` overview, from the anchor. |
| `onSpeech` | Route "where is...", "what's around me", "remember that...", "set up again"; send the rest to `g.ai.chat`. |
| `onButton` short | Take a photo, update memory, and say what changed. |
| `onButton` long | `g.stopSpeaking()`. |
| `onFrame` | Check for changes every few seconds, on the glasses or the phone (copy `examples/6-watch-ahead.ts`). |
| `onStop` | Clear the in-memory people list. |

Inside a multi-step exchange, use `g.listen()`. Speech that arrives while
`onSpeech` is busy is dropped.

## What the hardware does not give you

**1. The starter does not report heading or position.** Nothing in the `Glasses`
API says which way the wearer faces or where they are. This limits your
direction features:

- **O'clock from the wearer** works for things in the current photo, but the
  camera only covers what is ahead of them.
- **O'clock from the room file** is only true at the anchor. Say so: "From the
  main door, the table is at 2 o'clock."
- **Cardinal directions** cannot be worked out live without a compass. Without
  one, use them only as fixed facts about the room, such as "the north wall".
- **To get a position after the wearer moves,** ask them ("I'm at the table"), or
  match known items and signs in a new photo and say how sure the app is. This
  is a guess, so test it with the persona early.

**2. `onFrame` differs by device.** With **Use this phone**, including the
`adb reverse` setup, it gets one photo at a time from the phone camera. On the
glasses it gets video frames, which needs a Wi-Fi network that reaches the laptop,
a firewall that lets the video in (port 1935), and ffmpeg. If the glasses run hot,
try `FRAME_RATE=1` and `CAPTURE_FPS=1` in `.env`.

**3. This is not a collision warning.** A camera check takes seconds, and memory
can be out of date. The app must never say a path is clear, and it does not
replace a cane, a guide dog or anyone's own judgement.

**4. The shared budget is limited.** The guard turns Gemini off past 60 calls a
minute or 800 a run. Each utterance costs one or two calls, and each spoken
sentence costs one more. Check for changes every few seconds, and speak only
when something changed.

**5. Room data and photos go to Gemini.** Keep out anything the person would not
want sent, and tell them this during setup.

## Worksheet to code

### Part 2: Scenario

| Field | Where it goes |
|---|---|
| Setting, team, table | Design record |
| Persona: what they ask for | `needs.ts`, `EXAMPLE_PROFILES` |
| Task | The app's `name` and the first lines of `orientationPrompt` |
| Context | `room.json`; device notes in the Design record |
| Access gap and gap sentence | Design record; this becomes the demo's test |

### Part 3: Design the adaptation

| Field | Where it goes |
|---|---|
| What they can do | `orientationPrompt`, in words the person chose. `supportAreas` for broad areas |
| What they ask for | `needs.ts` and `prompt.ts` |
| Always ask me before... | `policy.ts` |
| What's there / what should be there | Design record, plus cases in `test/orientation.test.ts` |
| Inputs: speech | `onSpeech`, `g.listen()` |
| Inputs: gesture | `onButton` short or long. The glasses have one button and no keys |
| Inputs: keys | Typing in the dashboard's **Conversation** box only, for testing |
| Inputs: profile setting | `needs.ts`, `g.profile.get()` |
| Inputs: what the camera sees | `g.takePhoto()`, `onFrame`, `observe.ts` |
| Outputs: spoken step | `g.say()`, with `pacing: 'stepwise'` |
| Outputs: larger text | The `captions` need, shown on the phone. The glasses have no display |
| Outputs: simpler form | The `simplify` need |
| Outputs: pause to confirm | `confirm()` in `policy.ts` |
| Ideas and stars | Design record |
| Selected idea: what the agent does | `orientationPrompt`, `src/app.ts` |
| Selected idea: where it must stop and ask | `policy.ts` |
| Check it | Design record, plus tests |

### Part 4: Premortem

| Field | Where it goes |
|---|---|
| Adapter | Name it in the Design record. In this app, it's mainly `prompt.ts` and `src/orientation/` |
| Success sentence | Design record; check it in the demo |
| Failure and reasons | Turn each reason into a guard or a test, as below |

| Example reason | Guard |
|---|---|
| The room changed and the app gave old directions | Expiry times, and saying how old the information is |
| It described things that were not there | Answer from the room file and memory; test that it says when it does not know |
| It talked too much | Speak only on change; use the `spokenDetail` need |
| The direction style was wrong after moving | Name the reference point; ask the wearer where they are |
| The budget ran out mid-demo | Pace the checks; bring a demo path that uses the button |

### Part 5: Build plan

| Field | Where it goes |
|---|---|
| Way in, roles | Design record. A coding agent should read `AGENTS.md` and this file |
| API key | `.env`, which git ignores. Never in code or the Design record |
| Ability profile | `needs.ts`. Save only what the persona agreed to |
| Adapter | `src/toolkit/prompt.ts`, `src/toolkit/settings.ts`, `src/orientation/prompt.ts` |
| Verification | `policy.ts`, memory ages and tests |

## Stop and ask: `src/orientation/policy.ts`

Each "always ask me before" answer becomes one entry. Call `confirm()` before the
action, so the rule lives in code and does not rely on the model.

```ts
export async function confirm(g: Glasses, question: string): Promise<boolean> {
  await g.say(`${question} Say yes or no.`);
  const reply = await g.listen({ timeoutMs: 15000 });
  return !!reply && /\b(yes|yeah|sure|okay|ok)\b/i.test(reply);
}
```

No reply counts as no. Starting list; replace it with the persona's own answers:

- Saving a preference the app inferred (`AGENTS.md` requires this).
- Overwriting something in `room.json`.
- Remembering anything about a named person.

## Build order

1. Add `directionStyle` and its prompt line. Check it on the phone.
2. Write `room.example.json`, `room.ts` and `prompt.ts`, then answer "where is the
   table?" from the file.
3. Add the `on-entry` overview to `onStart`.
4. Add `policy.ts`, then `setup.ts`.
5. Add `memory.ts` and `observe.ts`, driven by the button.
6. Add `onFrame`, and test it on the phone before moving to the glasses.

After each step, run:

```bash
bun run typecheck
bun test
```

Then try it on the phone, and read the dashboard log for errors.

## Design record

Fill this in from the handouts. **This file can be committed, and the repo may be
public, so write only what the team is happy to share.** The handout says "You
choose what to share", and that applies here.

- **Team / table:**
- **Persona, and what they ask for:**
- **Task:**
- **Context:**
- **Access gap, and what they do today:**
- **Gap sentence:** Today, ___ can't ___ in ___ because ___.
- **What's there / what should be there:**
- **Ideas, with stars:**
- **Selected idea (what the agent does, and where it stops and asks):**
- **How we will know it worked:**
- **Adapter:**
- **Success:** A year from now, ___ can ___ in ___ without ___, and we can tell because ___.
- **Failure and reasons:**
- **Roles (builder, profile owner, tester, demo lead):**
