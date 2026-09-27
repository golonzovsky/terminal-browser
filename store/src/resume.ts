import { randomBytes } from "node:crypto";

import { store } from "./client";

export interface ResumeTab {
  url: string;
  title: string;
  active: boolean;
}

export interface ResumeSession {
  id: string;
  savedAt: number;
  tabs: ResumeTab[];
}

const PREFIX = "resume:";
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// short enough to retype from the hint printed on exit, long enough not to collide
function newId(): string {
  return randomBytes(4).toString("hex");
}

export function saveResumeSession(tabs: ResumeTab[]): string | null {
  if (tabs.length === 0) return null;
  const id = newId();
  const db = store().sqlite;
  db.prepare(
    "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`${PREFIX}${id}`, JSON.stringify({ savedAt: Date.now(), tabs }));
  prune(db);
  return id;
}

// sqlite's json functions throw on a malformed row, which would break saving on every exit,
// so entries are parsed here and anything unreadable is dropped along with the stale ones
function prune(db: ReturnType<typeof store>["sqlite"]): void {
  try {
    const rows = db
      .prepare("SELECT key, value FROM app_state WHERE key LIKE ?")
      .all(`${PREFIX}%`) as Array<{ key: string; value: string }>;
    const cutoff = Date.now() - KEEP_MS;
    const drop = db.prepare("DELETE FROM app_state WHERE key = ?");
    for (const row of rows) {
      let stale = true;
      try {
        const parsed = JSON.parse(row.value) as { savedAt?: number };
        stale = !Number.isFinite(parsed?.savedAt) || (parsed.savedAt as number) < cutoff;
      } catch {}
      if (stale) drop.run(row.key);
    }
  } catch {}
}

export function resumeSession(id: string): ResumeSession | null {
  const row = store()
    .sqlite.prepare("SELECT key, value FROM app_state WHERE key = ?")
    .get(`${PREFIX}${id}`) as { key: string; value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { savedAt: number; tabs: ResumeTab[] };
    if (!Array.isArray(parsed.tabs)) return null;
    return { id, savedAt: parsed.savedAt, tabs: parsed.tabs };
  } catch {
    return null;
  }
}

export function listResumeSessions(): ResumeSession[] {
  const rows = store()
    .sqlite.prepare("SELECT key, value FROM app_state WHERE key LIKE ? ORDER BY key")
    .all(`${PREFIX}%`) as Array<{ key: string; value: string }>;
  const sessions: ResumeSession[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as { savedAt: number; tabs: ResumeTab[] };
      if (Array.isArray(parsed.tabs)) {
        sessions.push({ id: row.key.slice(PREFIX.length), savedAt: parsed.savedAt, tabs: parsed.tabs });
      }
    } catch {}
  }
  return sessions.sort((a, b) => b.savedAt - a.savedAt);
}
