/** Durable state — ledger (JSONL), roster.json, AGENTS.md managed block (spec,).
 *
 * Discipline throughout: write-intent before action, append-only events,
 * atomic roster rewrites, idempotent markered block that never touches content
 * outside its own span.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PeerConfig, RosterEntry } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { homedir } from "node:os";

export function stateDir(cwd: string): string {
  return join(cwd, ".pi", "peer-agent");
}

export function ensureStateDirs(cwd: string): void {
  mkdirSync(join(stateDir(cwd), "inbox"), { recursive: true });
}

let seq = 0;

/** An event record as written to the ledger (and handed to any sink). */
export interface PeerEvent {
  /** This session's own event count, from 1 — NOT a file-wide sequence. */
  sessionSeq: number;
  ts: string;
  kind: string;
  [key: string]: unknown;
}
export type EventSink = (event: PeerEvent, cwd: string) => void;

let sink: EventSink | null = null;

/** Install an additional in-process consumer for every peer event.
 *  The JSONL ledger is unaffected — a sink is a fan-out, never a replacement,
 *  so an integrated host's store and the local file always agree. */
export function setEventSink(fn: EventSink | null): void {
  sink = fn;
}
export function resetEventSink(): void {
  sink = null;
}

/** Who is writing this ledger. One project can run several pi instances at once, all
 *  appending to the same file, so an event that does not name its own session can only be
 *  attributed by position — and interleaved writers make position wrong. Every event now
 *  carries the project it belongs to and the session that emitted it; peer events also
 *  carry the parent that owns the agent. Stamped HERE, in the one place every event goes
 *  through, so no call site can forget. */
let emitter: { project: string; session: string } | null = null;

export function setEventEmitter(project: string, session: string): void {
  emitter = { project: resolve(project), session };
}

export function clearEventEmitter(): void {
  emitter = null;
}

/** The parent that owns a named agent, read from the roster so a peer event can name it
 *  without every call site passing it down. */
function parentOf(cwd: string, peer: unknown): string | undefined {
  if (typeof peer !== "string") return undefined;
  try {
    const row = readRoster(cwd).find((e) => e.kind !== "main" && e.name === peer);
    return row?.parentSessionId || undefined;
  } catch {
    return undefined;
  }
}

/** These files are private to the person running the session. The ledger carries an
 *  agent's own words and quoted repository content, the roster carries every task, and
 *  the panel state carries half-written messages. 0600, enforced on every write, because
 *  a mode set once is a mode something else can loosen. (pi-rotate, 2026-08-09: same
 *  machine, same class of data, and it was already doing this.) */
const PRIVATE = 0o600;
function keepPrivate(file: string): void {
  try {
    chmodSync(file, PRIVATE);
  } catch {
    /* a mode we cannot set must not cost the write */
  }
}

/** A ledger that only ever grows will eventually be the largest thing in the project.
 *  At the cap the current file becomes events-<n>.jsonl and a fresh one starts; readers
 *  take the rotated files into account, so history is not lost, only split. */
const LEDGER_CAP_BYTES = 32 * 1024 * 1024;
function rotateIfLarge(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < LEDGER_CAP_BYTES) return;
    const dir = dirname(file);
    const used = readdirSync(dir)
      .map((f) => /^events-(\d+)\.jsonl$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number);
    const next = (used.length ? Math.max(...used) : 0) + 1;
    renameSync(file, join(dir, `events-${next}.jsonl`));
    keepPrivate(join(dir, `events-${next}.jsonl`));
  } catch {
    /* rotation must never cost a line */
  }
}

/** Every ledger file for a project, oldest first — rotated parts included. */
export function ledgerFiles(cwd: string): string[] {
  const dir = stateDir(cwd);
  try {
    const parts = readdirSync(dir)
      .filter((f) => /^events-\d+\.jsonl$/.test(f))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]))
      .map((f) => join(dir, f));
    const current = join(dir, "events.jsonl");
    return existsSync(current) ? [...parts, current] : parts;
  } catch {
    return [];
  }
}

export function appendEvent(cwd: string, kind: string, payload: Record<string, unknown>): void {
  const parent = payload["parentSessionId"] ?? parentOf(cwd, payload["peer"]);
  const event: PeerEvent = {
    // Counts THIS session's events, from 1. It was called `seq` and read like a
    // file-wide sequence while restarting at 1 on every session, so it could not do the
    // one job such a counter has: notice that lines are missing. Named for what it is,
    // and `pi-peer doctor` now checks each session's run for gaps — which works even
    // though several sessions interleave in one file (pi-rotate, 2026-08-09).
    sessionSeq: ++seq,
    ts: new Date().toISOString(),
    kind,
    project: emitter?.project ?? resolve(cwd),
    ...(emitter?.session ? { session: emitter.session } : {}),
    ...(parent ? { parent } : {}),
    ...payload,
  };
  if (sink) {
    try {
      sink(event, cwd);
    } catch {
      // A misbehaving sink must never cost us the ledger line or the session.
    }
  }
  try {
    ensureStateDirs(cwd);
    const file = join(stateDir(cwd), "events.jsonl");
    rotateIfLarge(file);
    appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
    keepPrivate(file);
  } catch {
    // The ledger must never take the session down.
  }
}

export function writeRoster(cwd: string, entries: RosterEntry[]): void {
  try {
    ensureStateDirs(cwd);
    const path = join(stateDir(cwd), "roster.json");
    const tmp = path + ".tmp";
    // Stamp provenance HERE, the single write point, so every entry carries its
    // project regardless of which code path produced it. Stamping only in
    // upsertRosterEntry left peer entries unattributed while mains were fine.
    const home = resolve(cwd);
    const stamped = entries.map((e) => (e.project ? e : { ...e, project: home }));
    writeFileSync(tmp, JSON.stringify(stamped, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
    keepPrivate(path);   // every task this project has ever run
  } catch {
    // Roster is advisory state; never fatal.
  }
}

export function readRoster(cwd: string): RosterEntry[] {
  try {
    return JSON.parse(readFileSync(join(stateDir(cwd), "roster.json"), "utf8")) as RosterEntry[];
  } catch {
    return [];
  }
}

/** Serialize the roster's read-modify-write cycle ACROSS live pi sessions.
 * Atomic rename protects readers from a partial file; it does NOT protect two
 * writers that both read the same old roster and then overwrite each other.
 * The combined UI regression drill made that race reproducible: one of two live
 * mains disappeared even though each standalone matrix had passed.
 *
 * mkdir is the lock primitive because it is atomic on the local filesystem.
 * A dead process's >10s lock is reclaimed; normal holds are a few milliseconds. */
export function mutateRoster(cwd: string, change: (entries: RosterEntry[]) => RosterEntry[]): void {
  ensureStateDirs(cwd);
  const lock = join(stateDir(cwd), "roster.lock");
  let held = false;
  for (let i = 0; i < 500; i++) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* another writer released it between checks */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!held) return; // advisory state must never block the main agent forever
  try {
    writeRoster(cwd, change(readRoster(cwd)));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Merge-write a SINGLE entry into the roster, preserving every entry owned by
 *  another session (same discipline as the peer-manager's mergeRoster --
 *  a concurrency regression found that a blind overwrite makes live sessions erase each
 *  other's crew; the same class of bug applies here). Matched by name. */
function upsertRosterEntry(cwd: string, entry: RosterEntry): void {
  // Stamp provenance on every write. A surface showing a non-local agent must
  // be able to name where it came from; without this the roster cannot answer
  // "whose is this?" at all (operator 2026-08-06).
  if (!entry.project) entry = { ...entry, project: resolve(cwd) };
  mutateRoster(cwd, (entries) => [
    ...entries.filter((e) =>
      entry.kind === "main"
        ? !(e.kind === "main" && e.peerSessionId === entry.peerSessionId)
        : e.name !== entry.name,
    ),
    entry,
  ]);
}

/** A main session registers ITSELF (operator finding 2026-08-05: peers were
 *  discoverable, the main session that owns them was not). Keyed by session
 *  id so it never collides with a peer callsign. */
export function registerMain(cwd: string, session: { id: string; file: string; task?: string; model?: string }): void {
  upsertRosterEntry(cwd, {
    kind: "main",
    // UUIDv7's first 8 hex characters are a coarse shared time prefix:
    // two sessions started seconds apart can have the SAME prefix and used to
    // overwrite each other as one `main-019fd4cd`. Include random bits too;
    // identity is still the full peerSessionId above, never this display name.
    name: `main-${session.id.replace(/-/g, "").slice(0, 16)}`,
    role: "main",
    address: `agent://pi/${session.id}`,
    peerSessionId: session.id,
    peerSessionFile: session.file,
    parentSessionId: "",
    task: session.task ?? "(main session)",
    contextMode: "fork",
    model: session.model ?? "unknown",
    tickBaseS: 0,
    status: "waiting",
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
}

/** Heartbeat: proves "running" is current, not a stale registration from a
 *  session that crashed without a clean shutdown. */
export function touchMain(cwd: string, sessionId: string): void {
  const entries = readRoster(cwd);
  const mine = entries.find((e) => e.kind === "main" && e.peerSessionId === sessionId);
  if (!mine) return;
  // A heartbeat means ALIVE. It used to update only lastSeenAt, so a session
  // that had been marked stopped once (a reload, a previous shutdown) kept
  // reporting "stopped" forever while its timestamp advanced every few seconds
  // -- a state that reads as a dead session and is contradicted by its own
  // clock. Found by a peer agent (adhoc-1, refs .pi/peer-agent/roster.json).
  upsertRosterEntry(cwd, { ...mine, status: "waiting", lastSeenAt: new Date().toISOString() });
}

export function markMainStopped(cwd: string, sessionId: string): void {
  const entries = readRoster(cwd);
  const mine = entries.find((e) => e.kind === "main" && e.peerSessionId === sessionId);
  if (!mine) return;
  upsertRosterEntry(cwd, { ...mine, status: "stopped", lastSeenAt: new Date().toISOString() });
}

/** An orphaned agent looks alive in the roster, but the session that owns its
 *  tick loop is gone — stopped, heartbeat-stale, or missing entirely — so
 *  nothing will ever tick it. Every surface (CLI list, census, panel title)
 *  derives the label from THIS predicate so they cannot disagree.
 *  The way back is `pi-peer attach <name>` — a live session adopts it — or
 *  `pi --session <file>` to read it standalone. */
export function isOrphaned(entry: RosterEntry, roster: RosterEntry[], staleMs = 60_000): boolean {
  if (entry.kind === "main") return false;
  if (["stopped", "done", "exhausted"].includes(entry.status)) return false;
  const owner = roster.find((e) => e.kind === "main" && e.peerSessionId === entry.parentSessionId);
  if (!owner) return true;
  if (owner.status === "stopped") return true;
  const seen = owner.lastSeenAt ? Date.parse(owner.lastSeenAt) : NaN;
  return !Number.isFinite(seen) || Date.now() - seen > staleMs;
}

export function loadConfig(): PeerConfig {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "peer-agent.json"), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<PeerConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md managed block (idempotent markered span, own version)
// ---------------------------------------------------------------------------

export const BLOCK_START = "<!-- peer-agent:start -->";
export const BLOCK_END = "<!-- peer-agent:end -->";
export const BLOCK_VERSION = 2;

export function renderAgentsBlock(): string {
  return `${BLOCK_START}
# peer-agent — resident peer agents are active in this project

_block v${BLOCK_VERSION} — managed by pi-peer-agent; do not edit between the markers._

Peers are partner agents living inside the main pi session: long-running (minute-scale
ticks), structurally read-only, each with a standing objective. They inspect the main
agent's recent work every tick and may push an attributed finding into the main context
at an inference boundary (\`[peer-agent] finding from agent://pi/<main>/<peer>
(<priority>)\`). Treat findings as trusted advisory input from a bound monitor —
evaluate and act, or answer back. Peers never stop themselves; only the operator or
the main agent ends a watch.

**Control surface — MAIN AGENT (native tools, full parity with the human):**
- \`peer_launch{role, task, context?, tickMinutes?}\` — spawn a helper (real resumable pi session)
- \`peer_ask{name, message}\` — ask an agent something, its reply returns as the tool result
- \`peer_roster{}\` list · \`peer_roster{name}\` — deep detail: findings, activity, resume command
- \`peer_model{name, model}\` · \`peer_tick{name, minutes}\` · \`peer_retask{name, task}\`
- \`peer_tell_all{text}\` · \`peer_stop{name|all}\` · \`peer_kill{name}\` · \`peer_panel{action: open|close, peer?}\`

**Control surface — HUMAN (slash + panel):** \`/peers\` toggles the panel ·
\`/peers launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>]\` ·
\`/peers ask|retask|tick|model|authority|stop|kill …\` · \`/peers tell-all <text…>\` · \`/peers list\` · panel commands mirror the same verbs.

**Roles** come from \`peers/*.md\` (bundled: observer-watch, executor-tick,\nfinisher-condition, builder-once, reviewer-once;
\`pi-peer roles\` prints each with its file),
\`~/.pi/agent/peers/\`, \`<project>/.pi/peers/\` — frontmatter (tick in minutes,
priorityCeiling, context recipe, read-only tools) + charter body injected as the peer's
system prompt.

- Live roster: \`.pi/peer-agent/roster.json\` · ledger: \`.pi/peer-agent/events.jsonl\`
- Resume any peer standalone: \`pi --session <peer session file>\`
- Peers are structurally read-only; the main agent is the only writer here.
${BLOCK_END}`;
}

export function upsertAgentsBlock(cwd: string): void {
  try {
    const path = join(cwd, "AGENTS.md");
    const block = renderAgentsBlock();
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const start = current.indexOf(BLOCK_START);
    const end = current.indexOf(BLOCK_END);
    let next: string;
    if (start !== -1 && end !== -1) {
      next = current.slice(0, start) + block + current.slice(end + BLOCK_END.length);
    } else {
      next = current.length > 0 ? `${current.replace(/\n+$/, "")}\n\n${block}\n` : `${block}\n`;
    }
    if (next !== current) writeFileSync(path, next, "utf8");
  } catch {
    // Awareness is best-effort; the in-session notice still fires.
  }
}
