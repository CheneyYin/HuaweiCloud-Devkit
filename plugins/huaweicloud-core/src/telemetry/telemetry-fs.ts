// Stamp-file IO micro-helpers for the telemetry family: the
// create-on-write directory guard, best-effort text reads, the empty-file
// touch stamps, and the UTC-date readers the DAU/first-use stamps compare.
// Every function is parameterized — the path constants live in the face
// (telemetry.ts) and arrive via the context, never derived here.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

export function writeTextFile(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

export function touchFile(filePath: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, '', 'utf8');
}

export function stampExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function getStampUTCDate(filePath: string): string | null {
  try {
    return new Date(statSync(filePath).mtime).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function getUTCToday(): string {
  return new Date().toISOString().slice(0, 10);
}
