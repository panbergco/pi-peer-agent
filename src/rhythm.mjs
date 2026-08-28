/** How often an agent wakes, in one sentence.
 *
 *  Plain JavaScript in its own file so the shell command and the in-session surfaces read
 *  the same words: it was hand-rolled in three places once, each with its own wording and
 *  its own default, and an audit found them disagreeing.
 */

/**
 * @param {string | undefined} kind  What the agent is: a task runs once, anything else
 *   is woken by the clock.
 * @param {number | undefined} tickSeconds
 * @returns {string}
 */
export function rhythm(kind, tickSeconds) {
  const tick = tickSeconds ?? 300;
  return kind === "task" ? "runs once" : `every ${Math.round(tick / 60)}m`;
}
