/** The project write lock — one writer at a time, in the SHARED worktree.
 *
 *  Human ruling (2026-08-06): peer-agent does NOT isolate writers in separate
 *  checkouts. Two agents (possibly in two different pi processes) work in the same
 *  directory on the same branch, and their mutations are serialized on an advisory
 *  lock — "one writer waited, both edits survived". Filesystem isolation exists only
 *  behind an explicit config opt-in.
 *
 *  Scope: the lock is held for the duration of ONE mutating tool call, not for a whole
 *  engagement. Per-call is what prevents interleaved writes without letting a long
 *  agent block everyone else, and it cannot deadlock: every acquire has a release in a
 *  finally, plus a staleness escape for a holder that died.
 *
 *  Mechanism: atomic exclusive create (O_EXCL) of a lock file naming its holder. That
 *  is flock's advisory contract expressed in the filesystem, with no dependency and no
 *  child process — and unlike flock(2) it survives being inspected by a human, since
 *  the holder is written in plain text inside it.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LockHolder {
  holder: string;
  pid: number;
  at: string;
}

/** Where the lock lives for a project. One lock per project directory. */
export function lockPath(cwd: string): string {
  return join(cwd, ".pi", "peer-agent", "write.lock");
}

function readHolder(file: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // exists but not ours
  }
}

/** A lock whose holder process is gone, or which is older than this, is stale. */
const STALE_MS = 5 * 60 * 1000;

export interface LockOutcome<T> {
  result: T;
  /** How long this caller waited for another writer, in ms. */
  waitedMs: number;
  /** Set when a dead or ancient holder's lock was taken over. */
  stole?: LockHolder;
}

/** Run `fn` while holding the project's write lock. */
export async function withWriteLock<T>(
  cwd: string,
  holder: string,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; pollMs?: number; onWait?: (waitedMs: number, current: LockHolder | null) => void } = {},
): Promise<LockOutcome<T>> {
  const file = lockPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = opts.pollMs ?? 150;
  const started = Date.now();
  let stole: LockHolder | undefined;
  let notified = false;

  for (;;) {
    try {
      const fd = openSync(file, "wx"); // atomic: fails if another writer holds it
      writeSync(fd, JSON.stringify({ holder, pid: process.pid, at: new Date().toISOString() } satisfies LockHolder));
      closeSync(fd);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const current = readHolder(file);
      const age = current ? Date.now() - Date.parse(current.at) : Infinity;
      if (!current || !alive(current.pid) || !Number.isFinite(age) || age > STALE_MS) {
        stole = current ?? undefined;
        rmSync(file, { force: true }); // holder is gone: taking over, and saying so
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`write lock held by ${current.holder} (pid ${current.pid}) for ${Math.round(age / 1000)}s — gave up after ${Math.round((Date.now() - started) / 1000)}s`);
      }
      if (!notified) {
        notified = true;
        opts.onWait?.(Date.now() - started, current);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  try {
    const result = await fn();
    return { result, waitedMs: Date.now() - started, ...(stole ? { stole } : {}) };
  } finally {
    // Release only OUR lock: if it was stolen from us while we ran, the new holder's
    // file must survive.
    const current = readHolder(file);
    if (!current || (current.pid === process.pid && current.holder === holder)) rmSync(file, { force: true });
  }
}
