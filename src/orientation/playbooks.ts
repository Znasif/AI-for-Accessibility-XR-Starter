// The prompts for the indoor orientation app. Most of what the app does is here.
//
// A playbook says what to report and in what order. How it is worded (clock or
// left and right, metres, comparisons, which side) comes from the profile,
// through src/toolkit/prompt.ts. Only preferences belong in these prompts: no
// names and no medical details, because prompts are sent to Gemini.
//
// Short by default: the wearer cannot talk over the app with the phone's mic
// off during speech, so every line costs them time. "Say more" gets the detail.

export type Playbook = 'general' | 'perimeter' | 'layout';

export function playbookOf(value: unknown): Playbook {
  return value === 'perimeter' || value === 'layout' ? value : 'general';
}

const HONEST = 'If the views do not show something, say so briefly. Do not guess. Never say that a path is clear or safe.';
const REFRAME = 'If the view is too high, too low, too close or off to one side to answer, say how to move the camera in a few words, and do not guess.';

export function appInstructions(): string {
  return `You help the wearer get oriented indoors. Reply in one short sentence, under 15 words, unless asked for more. All distances are rough estimates: say "about". ${HONEST} ${REFRAME}`;
}

// The person's own prompts, from the dashboard, in their order.
function questionsPrompt(questions: string[]): string {
  if (!questions.length) return 'Using these views of the room, say what this place is, its rough size, and the main things in it and where they are.';
  return `Using these views of the room, answer the wearer's prompts in exactly this order. They wrote "I" for themselves:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
}

const SPOKEN_ORDER = 'Do not use a list or numbers for the order: speak it as plain sentences.';

// The first answer: every point, in order, as briefly as it can be said.
export function briefPrompt(questions: string[]): string {
  return `${questionsPrompt(questions)}\nGive each point in under 10 words, and under ${Math.max(45, questions.length * 10)} words in all. Skip a point in a few words if the views do not show it. ${SPOKEN_ORDER} ${HONEST}`;
}

// "Say more": the same points in full.
export function detailPrompt(questions: string[]): string {
  return `${questionsPrompt(questions)}\nThe wearer asked for more detail, so give it, in under 90 words. ${SPOKEN_ORDER} ${HONEST}`;
}

// Which playbooks look at frames, and when. Each check is a Gemini call.
export function checksFrames(playbook: Playbook, walking: boolean): boolean {
  return playbook === 'layout' || (playbook === 'perimeter' && walking);
}

export interface FrameContext {
  previous: string;
  group: boolean;
  walked: string[];
}

export function framePrompt(playbook: Playbook, ctx: FrameContext, questions: string[] = []): string {
  const asked = questions.length ? ` The wearer asked to hear about: ${questions.join(' ')}` : '';
  const watch =
    playbook === 'perimeter'
      ? `The wearer is walking the perimeter of a room. Speak only about: a boundary about 2 metres ahead or closer, an obstacle on the way along the perimeter, or something sticking out at waist height or above within about 2 metres.${asked} If the profile asks for more about one side, check that side first. In "passed", name a wall corner, door or landmark the wearer has just reached, or leave it empty. Already passed: ${ctx.walked.join(', ') || 'nothing yet'}.`
      : `Speak only about: something within about 2 metres the wearer could bump or trip on.${asked}${ctx.group ? ' The wearer is standing with a group: in "state", count the people in view, and speak when people have left.' : ''}`;
  return `${watch}
Things simply being in the room are not news. Do not mention furniture, people or animals unless they are one of the things above. When in doubt, stay silent.
The last note: ${ctx.previous || 'none yet'}. Do not repeat what it already covers.
Reply with JSON: {"say": "", "urgent": false, "reframe": "", "passed": "", "state": ""}.
"say": under 8 words, only for one of the things above. Otherwise empty.
"urgent": true only for something within about 1 metre that the wearer could hit.
"reframe": a few words on moving the camera, only if this picture cannot be used at all. Otherwise empty.
"state": a very short note of what is here now, for the next comparison.
Never say that a path is clear or safe.`;
}

export interface FrameReply {
  say: string;
  urgent: boolean;
  reframe: string;
  passed: string;
  state: string;
}

export function parseFrameReply(text: string): FrameReply | null {
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    if (!r || typeof r !== 'object') return null;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return { say: str(r.say), urgent: r.urgent === true, reframe: str(r.reframe), passed: str(r.passed), state: str(r.state) };
  } catch {
    return null;
  }
}

export function perimeterPrompt(walked: string[]): string {
  return `The first picture was taken where the wearer began walking the perimeter. The second is the view now.
Landmarks passed, in order: ${walked.join(', ') || 'none noted'}.
Did the wearer get back to the start and cover the whole perimeter? Answer yes, no or not sure, how sure you are, and what seems missed, in under 20 words. This is a visual estimate: never say it is certain. ${HONEST}`;
}

export const QUICK_LOOK_PROMPT = 'In one sentence under 15 words, say the most useful thing about what is ahead of the wearer, and where.';

export function comparePrompt(name: string, saved: string): string {
  return `When the wearer was last in "${name}", it was described like this: ${saved}
Using these views of the room now, say what has moved or changed, and what you cannot check, in under 30 words. ${HONEST}`;
}

export function introLine(playbook: Playbook): string {
  const can =
    playbook === 'perimeter'
      ? 'new room or start perimeter'
      : playbook === 'layout'
        ? 'new room or stay here'
        : 'new room';
  return `Ready. I estimate, and I am not a mobility aid. Tap, then say ${can}. Hold for a quick look.`;
}
