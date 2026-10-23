import { getDb } from "../db/init.js";

export function getSessionVersion(): number {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'session_version'")
    .get() as { value: string } | undefined;
  const n = Number(row?.value ?? "1");
  return Number.isFinite(n) ? n : 1;
}

export function bumpSessionVersion(): number {
  const next = getSessionVersion() + 1;
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('session_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(String(next));
  return next;
}
