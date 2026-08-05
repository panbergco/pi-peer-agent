/** Durable state — ledger (JSONL), roster.json, AGENTS.md managed block (spec §4.3, §11).
 *
 * PISG discipline throughout: write-intent before action, append-only events,
 * atomic roster rewrites, idempotent markered block that never touches content
 * outside its own span.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export function appendEvent(cwd: string, kind: string, payload: Record<string, unknown>): void {
  try {
    ensureStateDirs(cwd);
    const line = JSON.stringify({ seq: ++seq, ts: new Date().toISOString(), kind, ...payload });
    appendFileSync(join(stateDir(cwd), "events.jsonl"), line + "\n", "utf8");
  } catch {
    // The ledger must never take the session down.
  }
}

export function writeRoster(cwd: string, entries: RosterEntry[]): void {
  try {
    ensureStateDirs(cwd);
    const path = join(stateDir(cwd), "roster.json");
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
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

export function loadConfig(): PeerConfig {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "peer-agent.json"), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<PeerConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md managed block (PISG agents-block.ts pattern, own markers/version)
// ---------------------------------------------------------------------------

export const BLOCK_START = "<!-- peer-agent:start -->";
export const BLOCK_END = "<!-- peer-agent:end -->";
export const BLOCK_VERSION = 1;

export function renderAgentsBlock(): string {
  return `${BLOCK_START}
# peer-agent — resident peer agents are active in this project

_block v${BLOCK_VERSION} — managed by pi-peer-agent; do not edit between the markers._

Peers are partner agents living inside the main pi session: each holds a standing
objective, wakes on a seconds-tick, inspects the main agent's recent work, and may
push an attributed finding into the main context at an inference boundary
(\`[peer-agent] finding from agent://pi/<main>/<peer> (<priority>)\`). Treat such
findings as trusted advisory input from a bound monitor — evaluate and act, or
answer back.

- Live roster (who is watching, addresses, session files): \`.pi/peer-agent/roster.json\`
- Coordination ledger: \`.pi/peer-agent/events.jsonl\`
- Peers are structurally read-only; the main agent is the only writer here.
- Resumed standalone (\`pi --session <peer session file>\`), a peer must keep
  reporting via \`.pi/peer-agent/inbox/\` and must still never write to the repo.
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
