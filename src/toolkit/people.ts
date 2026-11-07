// Named people on this laptop: each has profile needs, and the questions they
// want answered. The dashboard's Profile card picks the active one and edits it.
//
// Kept in data/orientation/people.json, out of git. Questions go into AI prompts.
// `notes` is for the people using the dashboard and is never sent to the AI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../starter/config.ts';
import type { Profile } from './profile.ts';

export interface Person {
  id: string;
  name: string;
  supportAreas: string[];
  needs: Array<{ dimension: string; value: unknown }>;
  entry: string[]; // asked on entering a room, in this order
  continuous: string[]; // watched for while the app runs
  notes: string;
}

export interface People {
  active: string;
  people: Person[];
}

const GENERAL: Person = { id: 'general', name: 'General', supportAreas: [], needs: [], entry: [], continuous: [], notes: '' };

const file = () => join(config.dataDir, 'orientation', 'people.json');

export const hasPeopleFile = (): boolean => existsSync(file());

export function loadPeople(): People {
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8')) as People;
    if (Array.isArray(data.people) && data.people.length) {
      return { active: data.people.some((p) => p.id === data.active) ? data.active : data.people[0]!.id, people: data.people };
    }
  } catch {
    /* no file yet, or it cannot be read: start from one general person */
  }
  return { active: GENERAL.id, people: [{ ...GENERAL }] };
}

function savePeople(data: People): void {
  mkdirSync(join(config.dataDir, 'orientation'), { recursive: true });
  writeFileSync(file(), JSON.stringify(data, null, 2));
}

export function activePerson(): Person {
  const data = loadPeople();
  return data.people.find((p) => p.id === data.active)!;
}

export function selectPerson(id: string): Person | null {
  const data = loadPeople();
  const person = data.people.find((p) => p.id === id);
  if (!person) return null;
  savePeople({ ...data, active: id });
  return person;
}

const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 20) : [];

export function savePerson(id: string, changes: { entry?: unknown; continuous?: unknown; notes?: unknown }): Person | null {
  const data = loadPeople();
  const person = data.people.find((p) => p.id === id);
  if (!person) return null;
  if (changes.entry !== undefined) person.entry = lines(changes.entry);
  if (changes.continuous !== undefined) person.continuous = lines(changes.continuous);
  if (changes.notes !== undefined) person.notes = String(changes.notes).slice(0, 4000);
  savePeople(data);
  return person;
}

export function addPerson(name: string): Person | null {
  const clean = name.trim().slice(0, 60);
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;
  const data = loadPeople();
  let id = slug;
  for (let n = 2; data.people.some((p) => p.id === id); n++) id = `${slug}-${n}`;
  const person: Person = { ...GENERAL, id, name: clean };
  savePeople({ active: id, people: [...data.people, person] });
  return person;
}

// A change to the profile (the dashboard, or "speak slower") stays with this person.
export function syncActiveNeeds(profile: Profile): void {
  const data = loadPeople();
  const person = data.people.find((p) => p.id === data.active)!;
  person.supportAreas = [...profile.supportAreas];
  person.needs = profile.needs.map((n) => ({ dimension: n.dimension, value: n.value }));
  savePeople(data);
}
