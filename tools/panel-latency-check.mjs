#!/usr/bin/env node
/**
 * Standing check: does the panel still open and close quickly?
 *
 * Run it any time — `npm run check:panel-latency`, from CI, or by hand. It drives a real
 * pi session on its own tmux socket, toggles the panel repeatedly, and exits non-zero if
 * closing regresses.
 *
 * This is the ONE implementation of the measurement; anything that needs the numbers
 * calls it rather than carrying a second copy, so a regression fails everywhere at once.
 *
 *   --cycles N   how many open/close pairs (default 8)
 *   --with-crew  measure the loaded path: launch an agent and leave an unsent draft first,
 *                so the close actually has state to persist
 *   --json       print the result as JSON on stdout
 *
 * Bounds: the median close must be no more than twice the median open, and under 200ms.
 * They are stated here, in the code that enforces them, so a document cannot claim a
 * stricter one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cycles = Number(args[args.indexOf("--cycles") + 1]) || 8;
const asJson = args.includes("--json");
const withCrew = args.includes("--with-crew");
const MAX_RATIO = 2;
// Overridable so the bound itself can be tested: set it to 0 and the check must fail on a
// healthy panel. A gate nobody has seen fail is a gate nobody should trust.
const MAX_CLOSE_MS = Number(process.env.PI_PEER_LATENCY_MAX_CLOSE_MS ?? 200);
// Opening needs its own ceiling: a ratio alone would accept a panel that became slow in
// BOTH directions, which is exactly what a regression looks like.
const MAX_OPEN_MS = Number(process.env.PI_PEER_LATENCY_MAX_OPEN_MS ?? 500);

const socket = `pi-peer-latency-${process.pid}`;
const T = `tmux -L ${socket}`;
const SESSION = "owned";
const proj = join(root, ".scratch", `panel-latency-${process.pid}`);
const sh = (cmd, timeout = 120000) => {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout });
  return (r.stdout ?? "") + (r.stderr ?? "");
};
const frame = () => sh(`${T} capture-pane -p -t ${SESSION}`);

const waitFor = (fn, tries) => {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    sh("sleep 1");
  }
  return false;
};

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  // Owned socket only. Never touch a tmux server this script did not start.
  sh(`${T} kill-session -t ${SESSION} 2>/dev/null || true`);
  // The session writes as it dies, so the directory can refill between the kill and the
  // removal. Retry, and never let cleanup throw over the result it is cleaning up after.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(proj, { recursive: true, force: true });
      break;
    } catch {
      sh("sleep 1");
    }
  }
  cleaned = true;
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(1); });

mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "README.md"), "# panel latency check\n");
sh(`${T} new-session -d -s ${SESSION} -x 200 -y 50 -c ${proj} bash`);
const model = process.env.PI_PEER_LATENCY_MODEL ?? "qwen-token-plan/deepseek-v4-flash-0731";
sh(`${T} send-keys -t ${SESSION} "pi -ne --extension ${join(root, "extensions", "index.ts")} --model ${model}" Enter`);
const sessionRegistered = () => {
  try {
    return JSON.parse(readFileSync(join(proj, ".pi/peer-agent/roster.json"), "utf8")).some((e) => e.kind === "main");
  } catch {
    return false;
  }
};
if (!waitFor(sessionRegistered, 120)) {
  console.error("panel-latency: no session came up — cannot measure");
  process.exit(2);
}

let crewSize = 0;
let draftSeen = false;
let liveEvidence = [];
let crewStillLive = null;
// Liveness is the PRODUCT's verdict, read as a field — not parsed from prose, not
// re-derived here. `pi-peer census --json` publishes `live` and `orphaned` from the same
// predicate the panel uses, so this check cannot drift from the surfaces.
const censusJson = () => {
  const r = spawnSync("node", [join(root, "bin", "pi-peer.mjs"), "census", "--json"], { cwd: proj, encoding: "utf8", timeout: 120000 });
  try {
    return JSON.parse(r.stdout ?? "[]");
  } catch {
    return [];
  }
};
const liveAgents = () => censusJson().filter((a) => a.live === true);

if (withCrew) {
  // The close path only does its real work when there is something to persist: an agent
  // selected and half-written text. Measuring a bare session would miss it.
  spawnSync("node", [join(root, "bin", "pi-peer.mjs"), "--cwd", proj, "launch", "observer-watch", "watch this project"], { cwd: proj, encoding: "utf8", timeout: 300000 });
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  waitFor(() => frame().includes("PEERS v"), 60);
  sh(`${T} send-keys -t ${SESSION} -l "unsent draft"`);
  draftSeen = waitFor(() => frame().includes("unsent draft"), 30);
  // Live means live: a stopped, retired or orphaned record would satisfy "an agent
  // exists" while persisting nothing on close.
  // Ask the PRODUCT whether an agent is live, instead of deciding here. `pi-peer census`
  // prints "orphaned" through the same predicate the panel uses, so this check can never
  // disagree with the surfaces about the same record — the mistake a hand-copied
  // definition invites.
  // The agent's session file is written a moment after it starts; wait for it rather than
  // declaring the session unloaded.
  waitFor(() => liveAgents().length > 0, 120);
  crewSize = liveAgents().length;
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  waitFor(() => !frame().includes("PEERS v"), 30);
  // Refuse rather than silently measure a bare session: a loaded-path claim that passes
  // with nothing loaded is worse than no claim.
  if (crewSize === 0 || !draftSeen) {
    console.error(`panel-latency: --with-crew asked for a loaded session and got ${crewSize} agent(s), draft ${draftSeen ? "present" : "MISSING"}`);
    cleanup();
    process.exit(2);
  }
}

const until = (pred, cap = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < cap) if (pred(frame())) return Date.now() - t0;
  return -1;
};
const captureFloor = (() => {
  const t = Date.now();
  for (let i = 0; i < 10; i++) frame();
  return Math.round((Date.now() - t) / 10);
})();
const open = [];
const close = [];
for (let i = 0; i < cycles; i++) {
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  open.push(until((f) => f.includes("PEERS v")));
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  close.push(until((f) => !f.includes("PEERS v")));
}
// A real median: with an even number of samples it is the average of the middle two.
// Taking the upper element reported 31ms for [17, 31] and called it a median.
const med = (a) => {
  const v = a.slice().sort((x, y) => x - y);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};
const medianOpenMs = med(open);
const medianCloseMs = med(close);
// Re-check the draft AFTER the timed cycles: sampling it once before them would certify a
// loaded path that emptied halfway through.
let draftStillThere = null;
if (withCrew) {
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  draftStillThere = waitFor(() => frame().includes("unsent draft"), 30);
  const stillLive = liveAgents();
  crewStillLive = stillLive.length;
  // The product's own record for each agent it still calls live, taken AFTER the cycles —
  // kept whole, including its live/orphaned verdict.
  liveEvidence = stillLive;
  sh(`${T} send-keys -t ${SESSION} C-M-o`);
  waitFor(() => !frame().includes("PEERS v"), 30);
}
const missed = open.filter((v) => v < 0).length + close.filter((v) => v < 0).length;
const ok = missed === 0 && medianOpenMs < MAX_OPEN_MS && medianCloseMs <= medianOpenMs * MAX_RATIO && medianCloseMs < MAX_CLOSE_MS && (!withCrew || (draftStillThere === true && crewStillLive > 0));
const result = { ok, cycles, withCrew, loadedState: withCrew ? { agents: crewSize, draftPresent: draftSeen, draftStillPresentAfterCycles: draftStillThere, agentsStillLiveAfterCycles: crewStillLive, evidence: liveEvidence } : null, medianOpenMs, medianCloseMs, captureFloorMs: captureFloor, missedToggles: missed, bounds: { maxRatio: MAX_RATIO, maxCloseMs: MAX_CLOSE_MS, maxOpenMs: MAX_OPEN_MS }, open, close };
cleanup();

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`panel latency · ${cycles} cycles${withCrew ? " · with an agent and an unsent draft" : ""} · open ${medianOpenMs}ms · close ${medianCloseMs}ms · capture floor ${captureFloor}ms`);
  console.log(`  bounds: open < ${MAX_OPEN_MS}ms · close <= ${MAX_RATIO}x open and < ${MAX_CLOSE_MS}ms`);
  if (missed) console.log(`  ${missed} toggle(s) never showed the expected state`);
  console.log(ok ? "OK — both directions are within bounds" : `FAILED — open must be < ${MAX_OPEN_MS}ms, close <= ${MAX_RATIO}x open and < ${MAX_CLOSE_MS}ms`);
}
process.exit(ok ? 0 : 1);
