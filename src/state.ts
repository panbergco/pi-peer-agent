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
- \`peer_talk{name, message}\` — message a peer, its reply returns as the tool result
- \`peer_roster{}\` list · \`peer_roster{name}\` — deep detail: findings, activity, resume command
- \`peer_retask{name, task}\` · \`peer_broadcast{text}\` · \`peer_stop{name|all}\`
- \`peer_panel{action: open|close, peer?}\` — surface the human-visible panel

**Control surface — HUMAN (slash + panel):** \`/peers\` toggles the panel ·
\`/peers launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>]\` ·
\`/peers talk <name> <text…>\` · \`/peers retask\` · \`/peers broadcast\` · \`/peers stop <name|all>\` · \`/peers list\` · panel: \`l\` launch, \`i\` insert finding, \`y/Y/r\` yank, \`x\` stop.

**Roles** come from \`peers/*.md\` (bundled: drift-sentinel, evidence-auditor, observer),
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
