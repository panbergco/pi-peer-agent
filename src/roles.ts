/** Role discovery — peers/*.md with pi-subagents-style frontmatter.
 *
 * Discovery order (later shadows earlier by name):
 *   <package>/peers/*.md  →  ~/.pi/agent/peers/*.md  →  <project>/.pi/peers/*.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextMode, PeerRole, Priority, Authority } from "./types.js";
import { AUTHORITY_TOOLS, DEFAULT_AUTHORITY } from "./types.js";

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
  // A contract may state what the agent IS. An unreadable value is refused by name
  // rather than silently defaulting: a role that says `kind: taks` must not quietly
  // become a watcher that never does the job it describes.
  const kindRaw = (fields["kind"] ?? "").split("#")[0]!.trim().toLowerCase();
  const KINDS = ["watch", "mission", "goal", "task"];
  if (kindRaw && !KINDS.includes(kindRaw)) {
    throw new Error(`${path}: kind "${kindRaw}" is not a kind of agent — use one of ${KINDS.join(", ")}`);
  }
  const kind = (kindRaw || undefined) as PeerRole["kind"];
  // A single-engagement agent never ticks — the runtime runs it once and never
  // schedules it. A `tick:` on such a contract is a promise the product cannot keep,
  // and two bundled roles carried one for weeks (operator: "where is the role that is a
  // one-off task without tick?"). Refuse it rather than print a cadence nobody honours.
  if (kindRaw === "task" && fields["tick"]) {
    throw new Error(`${path}: a task runs once and never ticks — remove "tick: ${fields["tick"]}"`);
  }
  // Authority is DECLARED in the role file: `authority: read-only | write | shell`.
  // Absent means read-only -- the default every peer has had since v1.
  // Strip a trailing `# comment` before comparing: a role file that says
  // `authority: read-only   # a pure observer` must not silently fall back to
  // the project default because the value did not match a literal.
  const declared = (fields["authority"] ?? DEFAULT_AUTHORITY).split("#")[0]!.trim() as Authority;
  const authority: Authority =
    declared === "write" || declared === "shell" || declared === "read-only" ? declared : DEFAULT_AUTHORITY;
  // A ceiling is the role's own limit on how far a human may elevate it.
  const declaredCeiling = (fields["authorityCeiling"] ?? "").split("#")[0]!.trim() as Authority;
  const authorityCeiling: Authority | undefined =
    declaredCeiling === "write" || declaredCeiling === "shell" || declaredCeiling === "read-only" ? declaredCeiling : undefined;
  const allowed = new Set(AUTHORITY_TOOLS[authority]);
  const declaredTools = (fields["tools"] ?? AUTHORITY_TOOLS[authority].join(", "))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  // A tools list may NARROW an authority; it may never claim a tool the authority does
  // not grant. Silently dropping the extras is how a role came to declare full authority
  // while holding read-only tools — the agent was told it could run commands and could
  // not. Refuse by file and value, exactly as an illegal kind is refused.
  const overreach = declaredTools.filter((t) => !allowed.has(t));
  if (overreach.length) {
    throw new Error(
      `${path}: tools ${overreach.join(", ")} are not granted by authority "${authority}" — ` +
        `raise the authority, or drop them (${authority} grants ${AUTHORITY_TOOLS[authority].join(", ")})`,
    );
  }
  const tools = declaredTools;

  const skills = (fields["skills"] ?? "")
    .split(",")
    .map((x) => x.split("#")[0]!.trim())
    .filter(Boolean);
  const fallbackModels = (fields["fallbackModels"] ?? "")
    .split(",")
    .map((m) => m.split("#")[0]!.trim())
    .filter(Boolean);

  return {
    name,
    file: path,
    description: fields["description"] ?? "",
    ...(kind ? { kind } : {}),
    ...(skills.length ? { skills } : {}),
    ...(fallbackModels.length ? { fallbackModels } : {}),
    tick,
    priorityCeiling: PRIORITIES.has(ceiling) ? ceiling : "steering",
    ...(authorityCeiling ? { authorityCeiling } : {}),
    context: CONTEXTS.has(context) ? context : "compacted",
    model: fields["model"] || undefined,
    thinking: fields["thinking"] || undefined,
    // Structural capability (P4): only the read-only set survives parsing.
    authority,
    // Explicit `tools:` still wins; otherwise the level decides the set.
    tools: tools.length > 0 ? tools : AUTHORITY_TOOLS[authority],
    tickWithoutDelta: (fields["tickWithoutDelta"] ?? "").toLowerCase() === "true",
    charter: body,
    source,
  };
}

/** Role files that could not be read, with the reason. A broken contract must not
 *  take the whole crew with it — the other roles still load, and the launch surface
 *  can say WHY the one you asked for is missing. */
export const roleErrors: Array<{ name: string; file: string; message: string }> = [];

function rolesFromDir(dir: string, source: string, out: Map<string, PeerRole>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const role = parseRole(join(dir, f), source);
      if (role) out.set(role.name, role);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const name = f.replace(/\.md$/, "");
      if (!roleErrors.some((e) => e.file === join(dir, f))) roleErrors.push({ name, file: join(dir, f), message });
    }
  }
}

export function discoverRoles(cwd: string): PeerRole[] {
  const out = new Map<string, PeerRole>();
  roleErrors.length = 0;
  const pkgPeers = join(dirname(dirname(fileURLToPath(import.meta.url))), "peers");
  rolesFromDir(pkgPeers, "bundled", out);
  rolesFromDir(join(homedir(), ".pi", "agent", "peers"), "user", out);
  rolesFromDir(join(cwd, ".pi", "peers"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The ONE description of a role, used by every surface.
 *
 *  Five places used to format this in their own words, and two of them still printed a
 *  cadence for roles that run once — the fault fixed twice already, surviving because
 *  nothing single-sourced the wording. A surface may choose its layout; it may not
 *  invent the facts or their order.
 */
export interface RoleSummary {
  name: string;
  description: string;
  kind: string;
  /** "runs once" for a single engagement, "tick 15m" for anything the clock wakes. */
  rhythm: string;
  authority: string;
  /** "capped write" when the role limits its own elevation, else "". */
  cap: string;
  ceiling: string;
  context: string;
  source: string;
  file: string;
}

export function roleSummary(role: PeerRole): RoleSummary {
  const home = process.env["HOME"] ?? "";
  const file = role.file ?? "";
  return {
    name: role.name,
    description: role.description,
    kind: role.kind ?? "watch",
    rhythm: role.kind === "task" ? "runs once" : `tick ${Math.round(role.tick / 60)}m`,
    authority: role.authority ?? "read-only",
    cap: role.authorityCeiling ? `capped ${role.authorityCeiling}` : "",
    ceiling: role.priorityCeiling,
    context: role.context,
    source: role.source,
    file: home && file.startsWith(home) ? `~${file.slice(home.length)}` : file,
  };
}

/** A single agent's rhythm, for surfaces describing a RUNNING agent rather than a
 *  role: "runs once" for a task, "every 15m" for anything the clock wakes. */
export function rhythmOf(a: { mode?: string; role: { kind?: string; tick: number } }): string {
  const kind = a.mode ?? a.role.kind;
  const tick = a.role.tick ?? 300;
  return kind === "task" ? "runs once" : `every ${Math.round(tick / 60)}m`;
}

/** One line, in the order every surface uses: what it is, when it wakes, what it may do. */
export function roleLine(role: PeerRole): string {
  const s = roleSummary(role);
  return [s.kind, s.rhythm, s.authority + (s.cap ? ` (${s.cap})` : ""), `up to ${s.ceiling}`, `${s.context} context`, s.source]
    .filter(Boolean)
    .join(" · ");
}

/** Build a role on the fly from a plain instruction.
 *
 *  Roles stay optional: `launch <role> <task>` still works, but
 *  `launch <task…>` with no known role synthesises one here, so a peer can be
 *  started from an instruction alone (operator 2026-08-06). The generated
 *  charter carries the same standing contract every bundled role has -- watch,
 *  report findings, stay read-only -- with the instruction as the objective.
 */
export function adhocRole(task: string, opts?: { kind?: PeerRole["kind"]; authority?: Authority }): PeerRole {
  const clean = task.trim().replace(/\s+/g, " ");
  // An agent launched without a role file gets the SAME contract fields a file would
  // give it. Before this, an ad-hoc launch could only ever be a watch, and its charter
  // asserted a read-only stance even when the operator had granted more.
  const authority = opts?.authority ?? DEFAULT_AUTHORITY;
  const readOnly = authority === "read-only";
  return {
    name: "adhoc",
    description: clean.length > 72 ? `${clean.slice(0, 69)}…` : clean,
    ...(opts?.kind ? { kind: opts.kind } : {}),
    tick: 300,
    priorityCeiling: "steering",
    context: "compacted",
    authority,
    tools: AUTHORITY_TOOLS[authority],
    tickWithoutDelta: false,
    source: "on-the-fly",
    charter: [
      "You are a resident peer agent: a partner watching a main pi session in this project.",
      "",
      "YOUR STANDING OBJECTIVE, given verbatim by the operator:",
      "",
      `    ${clean}`,
      "",
      "How you work:",
      "- You wake on a tick, inspect what the main agent has just done, and decide whether",
      "  anything is worth saying. Silence is a valid and common answer.",
      "- Verify before you speak. Read the actual files and output; never assert from memory",
      "  or from the instruction's wording alone.",
      "- When something IS worth raising, emit a finding: one self-contained paragraph that",
      "  a reader with no context can act on, citing the files it rests on.",
      readOnly
        ? "- You are structurally read-only. You never edit, never run mutating commands."
        : `- You hold ${authority} authority, granted deliberately by a human at launch: you MAY change files${authority === "shell" ? " and run commands" : ""} inside this project. Act on it when the task calls for it, keep changes minimal and reversible, and report what you changed.`,
      "",
      "End every turn with a verdict line: QUIET when there is nothing to report, or",
      "FINDING followed by your paragraph when there is.",
    ].join("\n"),
  };
}
