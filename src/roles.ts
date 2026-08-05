/** Role discovery — peers/*.md with pi-subagents-style frontmatter (spec §5).
 *
 * Discovery order (later shadows earlier by name):
 *   <package>/peers/*.md  →  ~/.pi/agent/peers/*.md  →  <project>/.pi/peers/*.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextMode, PeerRole, Priority } from "./types.js";

/** Tick spec (operator ruling: MINUTES are the unit — peers are long-running
 *  colleagues, not hyperactive watchers). Plain number = minutes; `10m`
 *  minutes; `90s` tolerated but clamped to the 1-minute floor. Returns SECONDS
 *  for internal timers. */
export function parseTick(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = String(raw).trim().match(/^(\d+)\s*(s|m)?$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const seconds = m[2]?.toLowerCase() === "s" ? n : n * 60;
  return Math.max(60, seconds);
}

const PRIORITIES = new Set(["info", "steering", "interrupt"]);
const CONTEXTS = new Set(["fork", "compacted", "fresh"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  if (!raw.startsWith("---")) return { fields, body: raw.trim() };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fields, body: raw.trim() };
  const head = raw.slice(3, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
  for (const line of head.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) fields[m[1]!.trim()] = m[2]!.trim();
  }
  return { fields, body };
}

function parseRole(path: string, source: string): PeerRole | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { fields, body } = parseFrontmatter(raw);
  const name = (fields["name"] ?? basename(path, ".md")).trim();
  if (!name || !body) return null;

  const tick = parseTick(fields["tick"]) ?? 300; // default: 5 minutes
  const ceiling = (fields["priorityCeiling"] ?? "steering") as Priority;
  const context = (fields["context"] ?? "compacted") as ContextMode;
  const tools = (fields["tools"] ?? "read, grep, find, ls")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => READ_ONLY_TOOLS.has(t));

  return {
    name,
    description: fields["description"] ?? "",
    tick,
    priorityCeiling: PRIORITIES.has(ceiling) ? ceiling : "steering",
    context: CONTEXTS.has(context) ? context : "compacted",
    model: fields["model"] || undefined,
    thinking: fields["thinking"] || undefined,
    // Structural capability (P4): only the read-only set survives parsing.
    tools: tools.length > 0 ? tools : ["read", "grep", "find", "ls"],
    tickWithoutDelta: (fields["tickWithoutDelta"] ?? "").toLowerCase() === "true",
    charter: body,
    source,
  };
}

function rolesFromDir(dir: string, source: string, out: Map<string, PeerRole>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const f of files) {
    const role = parseRole(join(dir, f), source);
    if (role) out.set(role.name, role);
  }
}

export function discoverRoles(cwd: string): PeerRole[] {
  const out = new Map<string, PeerRole>();
  const pkgPeers = join(dirname(dirname(fileURLToPath(import.meta.url))), "peers");
  rolesFromDir(pkgPeers, "bundled", out);
  rolesFromDir(join(homedir(), ".pi", "agent", "peers"), "user", out);
  rolesFromDir(join(cwd, ".pi", "peers"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
