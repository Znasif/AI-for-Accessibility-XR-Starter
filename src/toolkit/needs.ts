// The needs the toolkit profile can hold, in plain words, plus two example
// profiles to try. The dashboard shows the needs without showOnDashboard:
// false, so the page stays short. Apps can read and save the others.
// `fromToolkit` says whether the dimension is in the toolkit's own
// vocabulary or was added by this starter for audio.
//
// To add a need of your own: add an entry here, read it in settings.ts (or
// straight from g.profile.get('yourNeed') in your app), and it shows up on
// the dashboard. The toolkit accepts new dimension names.

export type NeedKind = 'toggle' | 'choice' | 'range';

export interface NeedSpec {
  key: string;
  label: string;
  help: string;
  kind: NeedKind;
  fromToolkit: boolean;
  default: boolean | string | number;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  showOnDashboard?: boolean; // default true
}

export const NEEDS: readonly NeedSpec[] = [
  {
    key: 'readAloudRate',
    label: 'Speaking speed',
    help: 'How fast the app talks. 1.0× is normal. Many screen reader users like it faster.',
    kind: 'range',
    min: 0.5,
    max: 2,
    step: 0.1,
    unit: '×',
    default: 1,
    fromToolkit: true,
  },
  {
    key: 'pacing',
    label: 'Steps',
    help: 'One step at a time means the app says one thing, then waits for you.',
    kind: 'choice',
    options: [
      { value: 'continuous', label: 'In one answer' },
      { value: 'stepwise', label: 'One step at a time' },
    ],
    default: 'continuous',
    fromToolkit: false,
  },
  {
    key: 'simplify',
    label: 'Plain language',
    help: 'Everyday words and short sentences.',
    kind: 'toggle',
    default: false,
    fromToolkit: true,
    showOnDashboard: false,
  },
  {
    key: 'spokenDetail',
    label: 'Detail',
    help: 'How much the app says at first.',
    kind: 'choice',
    options: [
      { value: 'gist', label: 'The gist first' },
      { value: 'standard', label: 'Normal' },
      { value: 'full', label: 'Full detail' },
    ],
    default: 'standard',
    fromToolkit: false,
  },
  {
    key: 'captions',
    label: 'Captions',
    help: 'The app’s words also appear as large text on the phone.',
    kind: 'toggle',
    default: false,
    fromToolkit: true,
    showOnDashboard: false,
  },
  {
    key: 'describeImages',
    label: 'Describe surroundings',
    help: 'When the app looks at a photo, it also mentions obstacles, signs and people.',
    kind: 'toggle',
    default: false,
    fromToolkit: true,
    showOnDashboard: false,
  },
  {
    key: 'orientationPlaybook',
    label: 'Room briefing',
    help: 'What the app reports in a room, and in what order.',
    kind: 'choice',
    options: [
      { value: 'general', label: 'General' },
      { value: 'perimeter', label: 'Perimeter walk' },
      { value: 'layout', label: 'Room layout' },
    ],
    default: 'general',
    fromToolkit: false,
  },
  {
    key: 'directionStyle',
    label: 'Directions',
    help: 'How the app says where things are.',
    kind: 'choice',
    options: [
      { value: 'relative', label: 'Left and right' },
      { value: 'clock', label: "O'clock" },
    ],
    default: 'relative',
    fromToolkit: false,
  },
  {
    key: 'distanceStyle',
    label: 'Sizes and distances',
    help: 'Metres, or metres with a comparison to something familiar.',
    kind: 'choice',
    options: [
      { value: 'metres', label: 'Metres' },
      { value: 'metres-comparison', label: 'Metres and comparisons' },
    ],
    default: 'metres',
    fromToolkit: false,
  },
  {
    key: 'extraDetailSide',
    label: 'More detail on',
    help: 'A side to hear more about.',
    kind: 'choice',
    options: [
      { value: 'none', label: 'Both sides equally' },
      { value: 'left', label: 'The left' },
      { value: 'right', label: 'The right' },
    ],
    default: 'none',
    fromToolkit: false,
  },
];

// The toolkit's support areas (toolkit/core/ability.js SUPPORT_AREAS), in plain words.
export const SUPPORT_AREAS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'vision', label: 'Seeing' },
  { key: 'hearing', label: 'Hearing' },
  { key: 'motor', label: 'Moving and handling things' },
  { key: 'cognitive', label: 'Memory and thinking' },
  { key: 'reading', label: 'Reading' },
  { key: 'sensory', label: 'Sensory comfort' },
];

// Starting points to try the toolkit quickly. Each one is one imagined
// person's choices, named by what it does. The toolkit's PROFILE-CARDS.md
// asks for this: name the need a preset serves, and leave out diagnoses.
export const EXAMPLE_PROFILES: ReadonlyArray<{
  key: string;
  label: string;
  supportAreas: string[];
  needs: Array<{ dimension: string; value: unknown }>;
}> = [
  {
    key: 'slow-steps',
    label: 'Slow, step by step',
    supportAreas: [],
    needs: [
      { dimension: 'readAloudRate', value: 0.8 },
      { dimension: 'pacing', value: 'stepwise' },
    ],
  },
  {
    key: 'fast',
    label: 'Fast speech',
    supportAreas: [],
    needs: [{ dimension: 'readAloudRate', value: 1.6 }],
  },
  { key: 'empty', label: 'Reset', supportAreas: [], needs: [] },
];

export function needSpec(key: string): NeedSpec | undefined {
  return NEEDS.find((n) => n.key === key);
}

export type NeedCheck = { ok: true; value: boolean | string | number } | { ok: false; reason: string };

// A value from the editor → the exact value the settings expect, or why not.
export function checkNeedValue(key: string, value: unknown): NeedCheck {
  const spec = needSpec(key);
  if (!spec) return { ok: false, reason: `unknown need "${key}"` };
  if (spec.kind === 'toggle') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${spec.label} is on or off` };
  if (spec.kind === 'choice') {
    const allowed = (spec.options ?? []).map((o) => o.value);
    return typeof value === 'string' && allowed.includes(value) ? { ok: true, value } : { ok: false, reason: `${spec.label} must be one of ${allowed.join(', ')}` };
  }
  const n = typeof value === 'number' ? value : Number(value);
  const { min = -Infinity, max = Infinity, step = 0 } = spec;
  if (!Number.isFinite(n) || n < min - 1e-9 || n > max + 1e-9) return { ok: false, reason: `${spec.label} must be from ${min} to ${max}` };
  const snapped = step > 0 ? Math.round((n - min) / step) * step + min : n;
  return { ok: true, value: Math.round(snapped * 100) / 100 };
}
