/** Shared types — spec docs/peer-agent-spec.md (§4–§7). */

export type Priority = "info" | "steering" | "interrupt";
export type ContextMode = "fork" | "compacted" | "fresh";
export type PeerStatus = "starting" | "waiting" | "thinking" | "error" | "stopped" | "suspended" | "done" | "exhausted";

/** Agent modes (spec §16). "watch" ticks forever against a standing objective;
 *  "mission" works bounded cycles until a FRAMEWORK-evaluated condition holds.
 *  The enum is open — a third (event-bound) mode is reserved, not designed. */
export type AgentMode = "watch" | "mission";

/** A mission's completion predicate — mechanical, never self-asserted.
 *  file: a path that must exist · exit0: a command that must exit 0. */
export interface Objective {
  kind: "file" | "exit0";
  value: string;
  /** Give up after this many cycles (default 20). */
  maxCycles?: number;
}

/** Evaluate a mission objective. Pure, synchronous, framework-owned. */
export function objectiveMet(obj: Objective, cwd: string): boolean {
  try {
    if (obj.kind === "file") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      const { isAbsolute, join } = require("node:path") as typeof import("node:path");
      return existsSync(isAbsolute(obj.value) ? obj.value : join(cwd, obj.value));
    }
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    return spawnSync("bash", ["-c", obj.value], { cwd, timeout: 60_000 }).status === 0;
  } catch {
    return false;
  }
}

export const PRIORITY_ORDER: Priority[] = ["info", "steering", "interrupt"];

export function priorityRank(p: Priority): number {
  return PRIORITY_ORDER.indexOf(p);
}

/** Role definition parsed from a peers/*.md file (spec §5). */
export interface PeerRole {
  name: string;
  description: string;
  /** Base tick cadence, seconds (floor 3). */
  tick: number;
  priorityCeiling: Priority;
  context: ContextMode;
  /** "provider/model-id" or undefined for the main session's model. */
  model?: string;
  thinking?: string;
  /** Allowlisted read-only tool names. */
  tools: string[];
  /** Run ticks even when the parent session produced no delta. */
  tickWithoutDelta: boolean;
  /** Body of the .md file — the role's standing charter. */
  charter: string;
  /** Where the role was discovered (for /peer listing + provenance). */
  source: string;
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
  /** Files this finding is about (E4), parsed from a trailing REFS: line. */
  refs?: string[];
}

export interface PeerConfig {
  toggleKey: string;
  /** Focus toggle: move the keyboard between panel and main prompt. */
  focusKey: string;
  maxPeers: number;
  /** Overlay geometry — btw-style responsive centered modal (ratio of terminal, clamped). */
  overlayWidthRatio: number;
  overlayHeightRatio: number;
  /** Auth/provider extensions loaded INTO peer sessions (never UI extensions).
   *  Needed so models whose providers are registered by extensions (e.g.
   *  devin) stream inside peers too. Resolved from ~/.pi/agent/npm. */
  providerExtensions: string[];
  /** Backoff multipliers applied to the role's base tick on consecutive quiet/skip. */
  backoff: number[];
  deltaCapChars: number;
}

export const DEFAULT_CONFIG: PeerConfig = {
  toggleKey: "ctrl+alt+p",
  focusKey: "ctrl+alt+l",
  maxPeers: 6,
  overlayWidthRatio: 0.7,
  overlayHeightRatio: 0.7,
  providerExtensions: ["pi-devin-auth", "pi-anthropic-oauth"],
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
  address: string;
  peerSessionId: string;
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
  /** Watch directory (E1): peer file tools rooted here when set. */
  watchCwd?: string;
  /** Agent mode (spec §16); absent = "watch" for pre-existing rosters. */
  mode?: AgentMode;
  /** Mission objective + progress (mode === "mission"). */
  objective?: Objective;
  cycles?: number;
  /** Cumulative usage (E2): tokens + cost across ticks and talks. */
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
