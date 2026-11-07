// Rooms the wearer asked the app to remember, as text. Kept in data/, on this
// laptop and out of git, so "did the furniture move?" can compare with last time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../starter/config.ts';

export interface SavedRoom {
  name: string;
  summary: string;
  savedAt: string;
}

const file = () => join(config.dataDir, 'orientation', 'rooms.json');

export function loadRooms(): SavedRoom[] {
  if (!existsSync(file())) return [];
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as SavedRoom[];
  } catch {
    return [];
  }
}

// Saving a name again replaces that room: the person asked for it by name.
export function saveRoom(name: string, summary: string): void {
  const clean = name.trim().toLowerCase();
  const rooms = loadRooms().filter((r) => r.name !== clean);
  rooms.push({ name: clean, summary, savedAt: new Date().toISOString() });
  mkdirSync(join(config.dataDir, 'orientation'), { recursive: true });
  writeFileSync(file(), JSON.stringify(rooms, null, 2));
}

export function findRoom(text: string): SavedRoom | undefined {
  const lower = text.toLowerCase();
  return loadRooms().find((r) => new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
}
