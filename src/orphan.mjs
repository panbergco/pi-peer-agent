/** Is this agent's session gone?
 *
 *  In plain JavaScript, and in its own file, for the same reason the rule engine is: the
 *  shell command and the in-session extension must answer this identically, and the
 *  command runs from wherever it was installed — where a TypeScript source cannot be
 *  imported. A copy in each surface, kept in step by a comment, is how the two drift.
 *
 *  An agent is orphaned when the session that launched it is gone: not in the roster,
 *  stopped, or silent for longer than a session that is alive would ever be. It is said
 *  out loud everywhere — list, census, panel — because an agent that will never tick again
 *  must not sit there looking like it is waiting.
 */

/**
 * @param {{kind?: string, status?: string, parentSessionId?: string}} entry
 * @param {Array<{kind?: string, status?: string, peerSessionId?: string, lastSeenAt?: string}>} roster
 * @param {number} [staleMs]  How long a live session may go unheard before it counts as gone.
 * @returns {boolean}
 */
export function isOrphaned(entry, roster, staleMs = 60_000) {
  if (entry.kind === "main") return false;
  if (["stopped", "done", "exhausted"].includes(String(entry.status))) return false;
  const owner = roster.find((e) => e.kind === "main" && e.peerSessionId === entry.parentSessionId);
  if (!owner) return true;
  if (owner.status === "stopped") return true;
  const seen = owner.lastSeenAt ? Date.parse(owner.lastSeenAt) : NaN;
  return !Number.isFinite(seen) || Date.now() - seen > staleMs;
}
