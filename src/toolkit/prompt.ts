// Profile → lines added to AI requests (g.ai.ask, g.ai.chat). This is
// how the profile changes WHAT the app says. The other half, how it is
// spoken, is the rate, pieces and pauses in say().
//
// The lines come from the wearable-extension project
// (src/toolkit-candidates/adapters/), where each was tested against real
// model output. The structured needs reach the prompt. The person's
// free-text notes stay out of it.

import type { Profile } from './profile.ts';
import { needValue, type AudioSettings } from './settings.ts';

// Plain words and short steps invite a model to talk down to people. This
// line is added when the profile adds other lines. (Kemper & Harden 1999;
// Williams et al. 2009.)
const RESPECT =
  "Speak to the person as a capable adult: no endearments, no baby talk, no 'we' or 'let's', no tag questions such as 'okay?', no over-praise.";

// `forData`: the answer is data for the app (g.ai.ask with json), and the app
// decides how to say it. Then the wording lines apply and the others are left out. "Give one
// action" would conflict with a request for the full list of steps.
export function profilePrompt(profile: Profile | null, s: AudioSettings, opts: { forData?: boolean } = {}): string {
  if (!profile || (!profile.needs.length && !profile.supportAreas.length)) return '';
  const lines: string[] = [];

  if (s.oneStepAtATime && !opts.forData) {
    lines.push(
      'Give ONE next action, then stop and wait. Do not list several steps. ' +
        'You may end with a few words asking them to tell you when it is done; do not tell them to say a particular word.',
      'When they say they have done it, in whatever words, begin with a few plain words naming what they just did, then give the next action.',
      'If they ask something partway through a step, answer it and carry on from where they are. Do not read the step out again word for word.',
    );
  }
  if (s.plainLanguage) {
    lines.push(
      "Use plain everyday words: say 'soap', 'big dial'. No jargon, no technical terms.",
      'Use one name for each thing, and keep it.',
      'Keep sentences short, one idea each. Start with the action, then say where.',
    );
  }
  if (s.detail === 'gist') lines.push('Give the one-sentence gist first. Wait to be asked before adding details.');
  if (s.detail === 'full') lines.push('Give complete detail: include small print, numbers and the wording as written.');
  if (s.describeImages) {
    lines.push('When a photo is attached, also mention what in it matters for getting around: obstacles, steps, doors, signs, people nearby. Say where each thing is.');
  }
  // Wording for where things are. These apply to JSON requests too, because
  // the app speaks the text in those answers.
  const direction = needValue(profile, 'directionStyle');
  if (direction === 'clock') {
    lines.push("Give every direction as a clock position from the way the wearer faces: 12 o'clock is straight ahead, 3 is right, 6 is behind, 9 is left. Use this in place of left, right and ahead.");
  }
  if (direction === 'relative') lines.push('Give directions as left, right, ahead and behind.');
  const distance = needValue(profile, 'distanceStyle');
  if (distance === 'metres') lines.push('Give distances in metres.');
  if (distance === 'metres-comparison') {
    lines.push('Give sizes, distances and shapes in metres, and compare each to something familiar and visual, such as a tennis court for the size of a room, or a fish for a long tapering shape. The person remembers how things look.');
  }
  const side = needValue(profile, 'extraDetailSide');
  if (side === 'left' || side === 'right') lines.push(`Give more detail about things on the wearer's ${side}, and mention that side first.`);
  if (profile.supportAreas.includes('vision')) lines.push("Seeing is one of the person's support areas. Read out text and signs in a photo, and give the position and distance of things that matter.");
  if (profile.supportAreas.includes('hearing')) lines.push('Keep each sentence short and complete, so it reads well as a caption.');

  if (!lines.length) return '';
  lines.push(RESPECT);
  return 'ABOUT THE PERSON (adapt to this):\n' + lines.map((l) => `- ${l}`).join('\n');
}
