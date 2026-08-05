/** Shared types — spec docs/peer-agent-spec.md (§4–§7). */

export type Priority = "info" | "steering" | "interrupt";
export type ContextMode = "fork" | "compacted" | "fresh";
export type PeerStatus = "starting" | "waiting" | "thinking" | "error" | "stopped";

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
  kind: "tick" | "thinking" | "text" | "tool" | "finding" | "note";
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
}

export interface PeerConfig {
  toggleKey: string;
  maxPeers: number;
  /** Overlay geometry — btw-style responsive centered modal (ratio of terminal, clamped). */
  overlayWidthRatio: number;
  overlayHeightRatio: number;
  /** Backoff multipliers applied to the role's base tick on consecutive quiet/skip. */
  backoff: number[];
  deltaCapChars: number;
}

export const DEFAULT_CONFIG: PeerConfig = {
  toggleKey: "ctrl+alt+p",
  maxPeers: 6,
  overlayWidthRatio: 0.7,
  overlayHeightRatio: 0.7,
  backoff: [1, 2, 4, 8],
  deltaCapChars: 6000,
};

export interface RosterEntry {
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
}

/** Simple monotonic-ish unique id (time + random) — ledger/envelope ids. */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function shortId(id: string | undefined): string {
  if (!id) return "????????";
  return id.length > 8 ? id.slice(0, 8) : id;
}
