/** Shared types — spec docs/peer-agent-spec.md (–). */

// Static imports, not require(): these helpers are executed by proof drills under
// plain node type-stripping as well as inside pi, and require() is not defined
// there (caught by the gate drill's own fixtures).
import { existsSync } from "node:fs";
import { isAbsolute, join as joinPath } from "node:path";
import { spawnSync } from "node:child_process";

export type Priority = "info" | "steering" | "interrupt";
export type ContextMode = "fork" | "compacted" | "fresh";
export type PeerStatus = "starting" | "waiting" | "thinking" | "error" | "stopped" | "suspended" | "done" | "exhausted" | "retired";

/** Agent modes. "watch" ticks forever against a standing objective;
 *  "mission" is also clock-driven, but WORKS its standing charge instead of reporting
 *  on someone else's work; like a watch, only a human ends it.
 *  "goal" works bounded cycles until a FRAMEWORK-evaluated condition holds.
 *  The enum is open — a third (event-bound) mode is reserved, not designed. */
export type AgentMode = "watch" | "mission" | "goal" | "task";

/** What a TASK agent hands back when its single engagement ends.
 *  The handoff IS the deliverable: without it the work is unreviewable. */
export interface Handoff {
  /** Free-text summary the operator reads first. */
  summary: string;
  changedFiles: string[];
  commands: string[];
  evidence: string[];
  surprises: string[];
  /** Anything the agent refused to decide alone — escalation, not silence. */
  decisions: string[];
  /** The raw handoff block as the agent wrote it, for audit. */
  raw: string;
}

/** Parse a TASK agent's HANDOFF block. Labelled lines only — no model is asked
 *  to produce JSON, because a malformed brace would lose the whole report. */
export function parseHandoff(text: string): Handoff | null {
  const start = text.search(/^\s*HANDOFF\s*:?\s*$/im);
  if (start < 0) return null;
  const raw = text.slice(start).replace(/^\s*HANDOFF\s*:?\s*$/im, "").trim();
  const field = (label: string): string[] => {
    const m = new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:summary|changed files|commands|evidence|surprises|decisions)\\s*:|$)`, "im").exec(raw);
    if (!m) return [];
    return m[1]!
      .split(/\n|;/)
      .map((s) => s.replace(/^\s*[-*]\s*/, "").trim())
      .filter((s) => s.length > 0 && !/^none$/i.test(s));
  };
  return {
    summary: (field("summary")[0] ?? raw.split("\n")[0] ?? "").slice(0, 500),
    changedFiles: field("changed files"),
    commands: field("commands"),
    evidence: field("evidence"),
    surprises: field("surprises"),
    decisions: field("decisions"),
    raw: raw.slice(0, 4000),
  };
}

/** A goal's completion predicate — mechanical, never self-asserted.
 *  file: a path that must exist · exit0: a command that must exit 0. */
export interface Objective {
  kind: "file" | "exit0";
  value: string;
  /** Give up after this many cycles (default 20). */
  maxCycles?: number;
}

/** Evaluate a goal objective. Pure, synchronous, framework-owned. */
export function objectiveMet(obj: Objective, cwd: string): boolean {
  try {
    if (obj.kind === "file") {
      return existsSync(isAbsolute(obj.value) ? obj.value : joinPath(cwd, obj.value));
    }
    return spawnSync("bash", ["-c", obj.value], { cwd, timeout: 60_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Run a TASK's acceptance gate. The FRAMEWORK runs it — a task cannot retire on
 *  its own word. Output is captured so a failing gate can be handed back
 *  to the agent as the reason, instead of a bare exit code. */
export function runGate(command: string, cwd: string, timeoutMs = 300_000): { passed: boolean; exitCode: number | null; output: string } {
  try {
    const r = spawnSync("bash", ["-c", command], { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { passed: r.status === 0, exitCode: r.status, output: output.slice(-4000) };
  } catch (err) {
    return { passed: false, exitCode: null, output: `gate could not run: ${String(err).slice(0, 300)}` };
  }
}

export const PRIORITY_ORDER: Priority[] = ["info", "steering", "interrupt"];

export function priorityRank(p: Priority): number {
  return PRIORITY_ORDER.indexOf(p);
}

/** Role definition parsed from a peers/*.md file. */
/** What an agent is allowed to DO. Declared in the role file's frontmatter as
 *  `authority: read-only | write | shell`.
 *
 *  DEFAULT: `shell`, scoped to the agent's own project directory (operator
 *  ruling 2026-08-06: "by default make it scoped to the project and give it
 *  full access"). Read-only was the original default; it turned out to make
 *  agents useless for the work they were being authorised to do. A role that
 *  should stay a pure observer declares `authority: read-only` explicitly.
 *
 *  Lowering or raising a RUNNING agent is still only ever an explicit human
 *  action (/authority, pi-peer authority) — there is no path by which an agent
 *  changes its own authority or another agent's. */
export type Authority = "read-only" | "write" | "shell";

/** Tool names each level adds on top of the level below. */
/** What an agent gets when its role says nothing. Project-scoped: every tool is
 *  rooted at the agent's own directory, so "full access" means full access
 *  THERE and nowhere else (project scoping still bounds it). */
/** Read-only is the floor for any agent whose role file does not say otherwise.
 *  It used to be "shell": a role omitting `authority:` was born able to run
 *  commands, which contradicts the spec's read-only wall (: write authority is
 *  granted per agent by an explicit human action). The bundled watchers all pin
 *  read-only explicitly, so the hole only showed on a role that did not — caught
 *  by a screenshot showing an objective agent badged shell. */
export const DEFAULT_AUTHORITY: Authority = "read-only";

export const AUTHORITY_TOOLS: Record<Authority, string[]> = {
  "read-only": ["read", "grep", "find", "ls"],
  write: ["read", "grep", "find", "ls", "edit", "write"],
  shell: ["read", "grep", "find", "ls", "edit", "write", "bash"],
};

export interface PeerRole {
  name: string;
  description: string;
  /** What this agent IS. A contract that declares its kind launches as that kind
   *  from every surface; an explicit launch flag still overrides it for ad-hoc work
   *  (operator 2026-08-08: "two types of ways to launch, manual and via a predefined
   *  contract"). Absent = a watch, the historical default. */
  kind?: AgentMode;
  /** Base tick cadence, seconds (floor 3). */
  tick: number;
  priorityCeiling: Priority;
  context: ContextMode;
  /** "provider/model-id" or undefined for the main session's model. */
  model?: string;
  /** Skills this agent should carry (by name), resolved through pi's own skill
   *  discovery at spawn. Declared as `skills: a, b` in the role file or at launch. */
  skills?: string[];
  /** Models to fall back to, in order, when a turn fails at the provider (rate
   *  limit, overload, quota, a path that refuses this agent). Declared in the role
   *  file as `fallbackModels: a, b` or passed at launch. */
  fallbackModels?: string[];
  thinking?: string;
  /** Allowlisted tool names (derived from `authority` unless listed explicitly). */
  tools: string[];
  /** Declared authority level. Absent = read-only. */
  authority?: Authority;
  /** Highest authority this role may EVER hold, declared in its own file as
   *  `authorityCeiling:`. A reviewer-once or observer-watch is read-only BY CONSTRUCTION: even
   *  the human-gated elevation ceremony refuses to raise it, so "advisory" is a
   *  mechanism here rather than a convention. */
  authorityCeiling?: Authority;
  /** Run ticks even when the parent session produced no delta. */
  tickWithoutDelta: boolean;
  /** Body of the .md file — the role's standing charter. */
  charter: string;
  /** Where the role was discovered (for /peer listing + provenance). */
  source: string;
  /** Where this role is defined. The file IS the template: an operator copies it to
   *  `~/.pi/agent/peers/` or `<project>/.pi/peers/` and edits. Learning that from the
   *  source code was the only way until now. */
  file?: string;
}

/** One transcript item in a peer's sidecar pane. */
export interface PaneEntry {
  kind: "tick" | "thinking" | "text" | "tool" | "finding" | "note" | "user";
  text: string;
  streaming?: boolean;
  priority?: Priority;
}

/** A delivered (or sidecar-only) finding. */
export interface Finding {
  id: string;
  peer: string;
  priority: Priority;
  clamped: boolean;
  tick: number;
  body: string;
  ts: number;
  /** Files this finding is about, parsed from a trailing REFS: line. */
  refs?: string[];
}

export interface PeerConfig {
  toggleKey: string;
  /** Focus toggle: move the keyboard between panel and main prompt. */
  focusKey: string;
  /** Additional chords that ALSO toggle focus. A terminal may claim a letter
   *  (WezTerm binds CTRL+L), leaving that chord permanently dead with no error
   *  anywhere — so more than one is accepted rather than betting on one. */
  focusAliases: string[];
  /** Chords that grow/shrink the panel. Several are accepted because desktops
   *  eat chords silently — GNOME binds Ctrl+Alt+Up/Down to workspace switching
   *  at the compositor, so a terminal never sees them (operator, 2026-08-06). */
  resizeUpKeys?: string[];
  resizeDownKeys?: string[];
  /** How the panel is drawn. "widget" renders above the editor and does NOT
   *  make pi relayout the screen; "overlay" is the original floating panel,
   *  kept as an escape hatch. Measured: any overlay, of any size or anchor,
   *  moves pi's footer by 12 lines the moment it exists — which reads as the
   *  transcript scrolling every time the panel opens. */
  render: "widget" | "overlay";
  /** Where the widget-rendered panel sits. "belowEditor" keeps the transcript
   *  and the prompt ADJACENT — the panel never wedges between them, which was
   *  the operator's objection to the default placement. "aboveEditor" is pi's
   *  default and puts the panel between transcript and prompt. */
  placement: "belowEditor" | "aboveEditor";
  /** Fraction of the terminal height the widget-rendered panel may occupy.
   *  Higher = the panel sits higher up the screen with a thinner transcript
   *  strip above it. pi offers no top-of-screen widget placement, so this is
   *  the only lever short of returning to an overlay. */
  panelHeightRatio: number;
  /** Separate git checkouts for writing agents. OFF by design: agents work in the
   *  SHARED worktree on the shared branch and serialize their mutations on the
   *  project write lock (human ruling 2026-08-06). Turning this on is an explicit,
   *  per-project choice; a worktree request is refused while it is off. */
  worktrees?: boolean;
  /** Opening the panel makes it ACTIVE (keyboard goes to it). Operator
   *  ruling 2026-08-05. Set false to open it as a passive view instead. */
  focusOnOpen: boolean;
  maxPeers: number;
  /** Overlay geometry — btw-style responsive centered modal (ratio of terminal, clamped). */
  overlayWidthRatio: number;
  overlayHeightRatio: number;
  /** Auth/provider extensions loaded INTO peer sessions (never UI extensions).
   *  Needed so models whose providers are registered by extensions (e.g.
   *  devin, or a rotating gateway) stream inside agents too. Resolved from every place pi
 *  installs packages — ~/.pi/agent/npm/node_modules and ~/.pi/agent/git — because a
 *  provider from a git-installed package used to be invisible here while the operator's
 *  own session had it. Add any other provider package by name. */
  providerExtensions: string[];
  /** Backoff multipliers applied to the role's base tick on consecutive quiet/skip. */
  backoff: number[];
  deltaCapChars: number;
}

export const DEFAULT_CONFIG: PeerConfig = {
  // macOS reports ⌘ only through the kitty keyboard protocol; elsewhere ctrl+alt
  // is the portable chord. Both families are accepted at match time either way
  // (see chordFamily), so a user override or a terminal in legacy mode still works.
  // O = Open (operator's own reading), and it is the chord proven to survive
  // this environment. P moves the keyboard between panel and main prompt.
  toggleKey: process.platform === "darwin" ? "super+alt+o" : "ctrl+alt+o",
  // ctrl+alt+O is the default because it is empirically the one that WORKS on
  // the operator's terminal: ctrl+alt+L is claimed by WezTerm (CTRL+L ->
  // ShowDebugOverlay) and never reaches the application, while O is unclaimed.
  // ctrl+alt+L stays accepted as an alias, so both work and neither report is
  // wrong.
  focusKey: process.platform === "darwin" ? "super+alt+p" : "ctrl+alt+p",
  focusAliases: ["ctrl+alt+l", "super+alt+l"],
  // shift+alt survives GNOME (which owns ctrl+alt+arrows for workspaces).
  resizeUpKeys: ["ctrl+alt+up", "shift+alt+up"],
  resizeDownKeys: ["ctrl+alt+down", "shift+alt+down"],
  render: "widget",
  placement: "belowEditor",
  panelHeightRatio: 0.5,
  worktrees: false,
  focusOnOpen: true,
  maxPeers: 6,
  overlayWidthRatio: 0.7,
  overlayHeightRatio: 0.7,
  providerExtensions: ["pi-devin-auth", "pi-anthropic-oauth", "pi-rotate"],
  backoff: [1, 2, 4, 8],
  deltaCapChars: 6000,
};

export interface RosterEntry {
  /** "peer" (default, omitted on existing entries for back-compat) or "main" --
   *  a main session registering ITSELF so it is discoverable/reachable from
   *  outside, not just its peers (operator finding 2026-08-05: "the main
   *  agent also must register"). */
  kind?: "peer" | "main";
  name: string;
  role: string;
  /** The file the role was read from, and the terms it carried at launch. A recovered
   *  agent could not be traced back to its contract, and a contract edited underneath a
   *  running agent was applied on the next recovery in silence. */
  roleFile?: string;
  roleTerms?: { kind?: string; authority?: string; tick: number; priorityCeiling: string; context: string };
  address: string;
  peerSessionId: string;
  /** Current authority level. Absent = read-only (back-compat with entries
   *  written before authority existed). */
  authority?: Authority;
  /** Absolute project directory this agent belongs to. Provenance: a surface
   *  that shows a non-local agent must be able to say WHERE it comes from,
   *  otherwise the row is noise (operator 2026-08-06). */
  project?: string;
  peerSessionFile: string;
  parentSessionId: string;
  task: string;
  contextMode: ContextMode;
  model: string;
  tickBaseS: number;
  status: PeerStatus;
  startedAt: string;
  /** kind === "main" only: last time this session touched its own entry
   *  (heartbeat) -- lets an outside viewer tell running from stale. */
  lastSeenAt?: string;
  /** Watch directory: peer file tools rooted here when set. */
  watchCwd?: string;
  /** Agent mode; absent = "watch" for pre-existing rosters. */
  mode?: AgentMode;
  /** Goal objective + progress (mode === "goal"). */
  objective?: Objective;
  cycles?: number;
  /** TASK kind only: the handoff summary, so a surface with no live session can
   *  still show what the retired task actually delivered. */
  handoffSummary?: string;
  /** TASK kind only: the acceptance command and whether the FRAMEWORK saw it pass,
   *  so a surface with no live session can still say whether the work was accepted. */
  gate?: string;
  gatePassed?: boolean;
  gateAttempts?: number;
  /** TASK kind only: wave membership — several tasks launched as one unit. */
  wave?: string;
  waveKey?: string;
  /** Cumulative usage: tokens + cost across ticks and answers. */
  usage?: { input: number; output: number; costUsd: number };
}

/** Simple monotonic-ish unique id (time + random) — ledger/envelope ids. */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function shortId(id: string | undefined): string {
  if (!id) return "????????";
  return id.length > 8 ? id.slice(0, 8) : id;
}
