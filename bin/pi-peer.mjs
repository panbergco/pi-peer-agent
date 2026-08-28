#!/usr/bin/env node
/**
 * pi-peer — drive a project's peer crew from any shell, no pi session needed
 * in THIS terminal. Commands are dropped as files into .pi/peer-agent/control/;
 * the live pi session's peer-agent extension applies them within ~5s and acks
 * through the ledger (events.jsonl), which this CLI tails for the answer.
 *
 * Reads (list, findings) come straight from roster.json / events.jsonl and
 * need no live session at all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);

function fail(msg) {
  console.error(`pi-peer: ${msg}`);
  process.exit(1);
}

// --cwd <dir> anywhere
let cwd = process.cwd();
{
  const i = argv.indexOf("--cwd");
  if (i !== -1) {
    cwd = path.resolve(argv[i + 1] ?? fail("--cwd needs a directory"));
    argv.splice(i, 2);
  }
}

// ---- who this command line may reach --------------------------------------
// Default: it touches the project it is run from. Reaching into another project takes a
// rule that names it, the same rules the agents obey — see `pi-peer rules`. The old
// mechanism (a mode plus a list, written by `pi-peer allow`) is gone: it was read here and
// nowhere else, so it never governed the agents it appeared to govern.
function enforceScope() {
  // The command line obeys the same rules the agents do: one question, answered once on
  // the machine, instead of a second mechanism with its own words for the same idea.
  const here = path.resolve(process.cwd());
  const target = path.resolve(cwd);
  if (target === here) return; // own project: the rules cover this too, but it is the common case
  const attempt = { from: "parent", fromName: "the command line", fromProject: here, to: "peer", toName: "*", toProject: target };
  const verdict = judge(attempt, loadRules(here));
  if (verdict.allowed) return;
  fail(
    `refused: this command targets another project (${target}).\n  ` +
      refusalText(attempt, verdict).replace(/\n/g, "\n  "),
  );
}


const stateDir = path.join(cwd, ".pi", "peer-agent");
const controlDir = path.join(stateDir, "control");
const ledgerPath = path.join(stateDir, "events.jsonl");
const rosterPath = path.join(stateDir, "roster.json");

const verb = argv.shift();

// `allow` and `disallow` set a mode and a list that the send path never consulted, so a
// human could "allow" a project and nothing changed. Reach is rules now, and widening one
// is deliberately a human edit — the command says where to write it.
if (verb === "allow" || verb === "disallow") {
  const dir = path.resolve(argv[0] ?? fail(`usage: pi-peer ${verb} <dir>`));
  fail(
    `"${verb}" is gone. Who may speak to whom is a rule set now — see: pi-peer rules\n` +
      `  To let this project reach ${dir}, add to "talk" in ${machineRulesFile()}:\n` +
      `    { "from": "peer", "to": "peer", "in": "${path.resolve(process.cwd())}", "to_project": "${dir}", "allow": true }\n` +
      `  To take reach away without editing that file:  pi-peer rules deny <from> <to>`,
  );
}

if (verb === "version" || verb === "--version" || verb === "-v") {
  // Which build is actually running. This exists because a stale global copy
  // silently answered for the source checkout more than once, and every
  // conclusion drawn against it was worthless.
  const selfPkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "package.json");
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const mine = read(selfPkg);
  console.log(`pi-peer ${mine?.version ?? "?"}`);
  console.log(`  running from: ${path.dirname(selfPkg)}`);
  const globalPkg = "/usr/lib/node_modules/pi-peer-agent/package.json";
  const g = read(globalPkg);
  if (g) {
    console.log(`  installed globally: ${g.version} (/usr/lib/node_modules/pi-peer-agent)`);
    if (mine && g.version !== mine.version) {
      console.log(`  ⚠ MISMATCH: this CLI is ${mine.version} but the globally installed extension is ${g.version}.`);
      console.log("    Sessions load the global copy unless settings point at a path. Re-pack with:");
      console.log("      npm pack && sudo npm install -g ./pi-peer-agent-<version>.tgz");
    }
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"));
    const entry = (s.packages ?? []).find((p) => String(p).includes("peer-agent"));
    if (entry) console.log(`  sessions load: ${entry}`);
  } catch {
    /* advisory */
  }
  process.exit(0);
}
if (verb === "scope") {
  fail(
    `"scope" is gone — it named a mode the send path never consulted, so setting it changed nothing.\n` +
      `  To see who may speak to whom:  pi-peer rules\n` +
      `  To let this project reach another, add to "talk" in ${machineRulesFile()}:\n` +
      `    { "from": "peer", "to": "peer", "in": "${path.resolve(process.cwd())}", "to_project": "<the other project>", "allow": true }\n` +
      `  To take reach away:  pi-peer rules deny <from> <to>`,
  );
}
enforceScope();

/** The same sentence, read from a roster entry rather than a loaded role. */
function rhythmOf(entry) {
  return rhythm(entry.mode ?? entry.roleTerms?.kind, entry.tickBaseS ?? entry.roleTerms?.tick);
}



// ── who may speak to whom ────────────────────────────────────────────────────
// ONE implementation, imported from the same file the agents obey. This used to be a
// hand-copied twin here, and it drifted twice in one day: a wildcard changed meaning in
// the real engine and the copy kept answering the old way. Node strips the types on
// import, so there is nothing to build and nothing to keep in step.
import {
  judge,
  loadRules,
  refusalText,
  effectiveRules,
  machineRulesFile,
  projectRulesFile,
  DEFAULT_RULES,
} from "../src/talkrules.mjs";

function readRoster() {
  try {
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return [];
  }
}

import { isOrphaned } from "../src/orphan.mjs";
import { rhythm } from "../src/rhythm.mjs";


/** Every ledger part for this project, oldest first — the current file plus any that
 *  rotation has closed. Reading only the current one would quietly lose history. */
function ledgerParts() {
  try {
    const parts = fs
      .readdirSync(stateDir)
      .filter((f) => /^events-\d+\.jsonl$/.test(f))
      .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
      .map((f) => path.join(stateDir, f));
    return fs.existsSync(ledgerPath) ? [...parts, ledgerPath] : parts;
  } catch {
    return [];
  }
}

function readLedgerTail(n = 2000) {
  try {
    return ledgerParts()
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("")
      .trim()
      .split("\n")
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

/** A boolean flag: present or absent, no value. */
function takeSwitch(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  argv.splice(i, 1);
  return true;
}

function enqueue(cmd) {
  fs.mkdirSync(controlDir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(controlDir, `${id}.json`), JSON.stringify({ id, ...cmd }, null, 2));
  return id;
}

async function awaitAck(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = readLedgerTail(400).find((e) => e.kind === "control.applied" && e.id === id);
    if (ack) return ack;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function run(cmd, { timeoutMs = 30_000, quietOk = false, silentReply = false } = {}) {
  const id = enqueue(cmd);
  const ack = await awaitAck(id, timeoutMs);
  if (!ack) {
    fail(
      `no live pi session picked the command up within ${Math.round(timeoutMs / 1000)}s.\n` +
        `  (queued as ${path.join(controlDir, `${id}.json`)} — a session in ${cwd} will apply it when one runs)`,
    );
  }
  if (!ack.ok) fail(ack.message ?? "command failed");
  if (!quietOk && ack.message) console.log(ack.message);
  if (ack.reply && !silentReply) console.log(`\n${ack.reply}`);
  return ack;
}

const HELP = `pi-peer — control a project's resident peer crew from the shell

usage: pi-peer [--cwd <dir>] <command>

  census                                   FULL picture of every agent (no live session needed)
  history [--session <id>] [--peer <n>]    project → each pi session → the agents it spawned, with transcripts
          [--json]
  list                                     one-line crew overview (no live session needed)
  findings [name]                          delivered findings from the ledger (no session needed)
  launch <role> <task…> [--tick <min>] [--context fork|compacted|fresh] [--watch <dir>]
         [--until-file <path> | --until-exit0 '<cmd>'] [--max-cycles N]   # GOAL mode
  task [role] <job…> [--authority read-only|write|shell] [--gate '<command>'] [--worktree]
                                           [--fallback 'model,model']  survive a provider failure
                                           [--skills 'name,name']      carry pi skills into the agent
                                           [--context fork|compacted|fresh]
                                           one engagement, runs to completion, hands off, retires
                                           (--authority is the human grant: a task cannot be raised later)
  mission [role] <charge…> [--tick <min>] [--authority …] [--skills …] [--fallback …]
                                           a ticked WORKER: advances its own charge every
                                           tick until you stop it (never ends itself)
  wave [role] <key=job> <key=job> …        several tasks as ONE unit — you hear once,
                                           when the last one retires (same flags as task)
  roles                                    the roles you can launch, and the file each one
                                           is defined in (copy one as a template)
  cost                                     what the crew has cost, per agent and in total
  doctor                                   one read-only check of config, state, orphans,
                                           the write lock and the ledger (non-zero on faults)
  authority [<name> <level>]               show or change an agent's authority
                                           (read-only | write | shell — human action)
  rules                                    every rule in force, and the file each came from
  rules --why <from> <to> [--to-project <dir>]   the verdict a message would get, and what would allow it
  rules deny <from> <to> [--project <dir>] narrow what you may reach (widening is a human edit)
  audit                                    every message attempted: who, to whom, allowed or refused, by which rule
  ask <name> <message…>                    ask one of your agents something, print its reply
  ask-parent <session-id> <message…>       ask a pi session itself (delivered into its live turn)
  tell-all <message…>                      say the same thing to every agent in this project
  retask <name> <task…> [--tick <min>]
  tick <name> <minutes>                    change a peer's interval
  models [query]                           list pi's available models (the panel's source)
  model <name> [provider/model|substring]  switch a peer's model — bare or ambiguous
                                           forms show a numbered picker on a TTY
  attach <name>                            adopt an orphaned agent (its own session is
                                           gone) into THIS session's crew — it ticks again
  stop <name|all>                           end the watch (session kept, resumable)
  kill <name>                              end the watch AND delete the peer's session

Write commands need a live pi session in the project (applied within ~5s).`;

async function main() {
  switch (verb) {
    case "list": {
      const roster = readRoster();
      if (roster.length === 0) {
        console.log("no peers (roster empty) — launch one with: pi-peer launch <role> <task…>");
        return;
      }
      for (const e of roster) {
        const u = e.usage ? ` ↑${e.usage.input} ↓${e.usage.output} $${e.usage.costUsd.toFixed(3)}` : "";
        const m = e.kind === "main"
          ? " [MAIN SESSION]"
          : e.mode === "mission" ? ` [mission · working]`
          : e.mode === "task" ? ` [task${e.waveKey ? ` · wave ${e.waveKey}` : ""}${e.status === "retired" ? " · retired" : " · running"}]`
          : e.mode === "goal" ? ` [goal ${e.cycles ?? 0}/${e.objective?.maxCycles ?? 20} until ${e.objective?.kind}:${e.objective?.value}]` : "";
        const shown = isOrphaned(e, roster) ? "orphaned" : String(e.status);
        console.log(
          // A task never ticks — printing an interval for one is the fault this crew
          // spent two rounds of work removing from the other surfaces.
          `${e.name.padEnd(14)} ${e.role.padEnd(18)} ${shown.padEnd(10)} ${rhythmOf(e).padEnd(10)}${u}${m} · ${e.task}`,
        );
      }
      return;
    }
    case "census": {
      // The complete picture from durable state — no live session needed.
      const roster = readRoster();
      // `--json` publishes the same picture for a program to read, including the product's
      // OWN live/orphaned verdict, so nothing downstream has to re-derive it from prose.
      if (argv.includes("--json")) {
        console.log(JSON.stringify(roster.filter((e) => e.kind !== "main").map((e) => ({
          name: e.name,
          role: e.role,
          mode: e.mode,
          status: e.status,
          orphaned: isOrphaned(e, roster),
          live: !isOrphaned(e, roster) && !["stopped", "done", "exhausted", "retired", "suspended", "error", "failed"].includes(String(e.status)),
          task: e.task,
          rhythm: rhythmOf(e),
          model: e.model,
          ...(e.roleFile ? { contract: e.roleFile } : {}),
        })), null, 2));
        return;
      }
      const led = readLedgerTail(5000);
      const findingsBy = {};
      for (const e of led) {
        if ((e.kind === "finding.delivered" || e.kind === "inbox.delivered") && e.peer) {
          findingsBy[e.peer] = (findingsBy[e.peer] ?? 0) + 1;
        }
      }
      const spawned = led.filter((e) => e.kind === "peer.spawned");
      if (roster.length === 0) {
        console.log("no agents on record — launch one with: pi-peer launch <role> <task…>");
        return;
      }
      const mains = roster.filter((e) => e.kind === "main");
      const agents = roster.filter((e) => e.kind !== "main");
      console.log(`AGENT CENSUS · ${mains.length} main session(s) + ${agents.length} agent(s) · project ${cwd}\n`);
      for (const m of mains) {
        const stale = m.lastSeenAt && Date.now() - Date.parse(m.lastSeenAt) > 60_000;
        const state = m.status === "stopped" ? "stopped" : stale ? "no heartbeat (stale?)" : "running";
        console.log(`${m.name}  [MAIN SESSION] · ${state}`);
        console.log(`  address : ${m.address}`);
        console.log(`  started : ${m.startedAt}${m.lastSeenAt ? ` · last seen ${m.lastSeenAt}` : ""}`);
        console.log(`  ask     : pi-peer --cwd ${cwd} ask-parent ${m.peerSessionId.slice(0, 8)} "…"`);
        console.log(`  resume  : pi --session ${m.peerSessionFile}\n`);
      }
      for (const e of agents) {
        const mode = e.mode ?? "watch";
        const prog = mode === "goal"
          ? `cycles ${e.cycles ?? 0}/${e.objective?.maxCycles ?? 20} until ${e.objective?.kind}:${e.objective?.value}`
          : e.mode === "mission"
          ? `MISSION · works its charge ${rhythmOf(e)}`
          : e.mode === "task"
          ? `TASK${e.waveKey ? ` (wave ${String(e.wave).slice(0, 6)} · key ${e.waveKey})` : ""} · one engagement${e.status === "retired" ? ", retired" : ""}${e.gate ? ` · gate ${e.gatePassed ? "passed" : `NOT passed (${e.gateAttempts ?? 0} attempts)`}: ${e.gate}` : ""}`
          : `ticks ${rhythmOf(e)}`;
        const u = e.usage ? `↑${e.usage.input} ↓${e.usage.output} $${e.usage.costUsd.toFixed(3)}` : "no usage recorded";
        const orphan = isOrphaned(e, roster);
        console.log(`${e.name}  [${mode}] ${e.role} · ${orphan ? "orphaned" : e.status}`);
        if (orphan) console.log(`  orphaned: its session is gone — no live session is ticking this agent; resume it below`);
        console.log(`  purpose : ${e.task}`);
        console.log(`  progress: ${prog} · findings ${findingsBy[e.name] ?? 0}`);
        if (e.handoffSummary) console.log(`  handoff : ${e.handoffSummary}`);
        console.log(`  cost    : ${u} · model ${e.model}`);
        // Where its contract came from: a recovered agent used to be untraceable to the
        // file that defines it.
        if (e.roleFile) console.log(`  contract: ${e.roleFile.replace(os.homedir(), "~")}`);
        if (e.watchCwd) console.log(`  watching: ${e.watchCwd}`);
        console.log(`  address : ${e.address}`);
        console.log(`  ask     : pi-peer --cwd ${cwd} ask ${e.name} "…"`);
        console.log(`  resume  : pi --session ${e.peerSessionFile}\n`);
      }
      const missing = spawned.map((s) => s.peer).filter((n) => !roster.some((r) => r.name === n));
      if (missing.length > 0) console.log(`NOTE: ${missing.length} spawned agent(s) not in the roster: ${[...new Set(missing)].join(", ")}`);
      return;
    }
    case "history": {
      // One project runs several pi instances, and each spawns its own agents. This is
      // that shape, read straight out of the ledger: project → session → its agents.
      // Nothing is inferred from position — every event names the session that wrote it.
      const all = readLedgerTail(100000);
      const wantSession = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : null;
      const wantPeer = argv.includes("--peer") ? argv[argv.indexOf("--peer") + 1] : null;
      const roster = readRoster();
      const fileOf = (id) => roster.find((e) => e.peerSessionId === id)?.peerSessionFile ?? null;
      const project = all.find((e) => e.project)?.project ?? cwd;
      const sessions = new Map();
      const touch = (id) => {
        if (!sessions.has(id)) sessions.set(id, { id, started: null, ended: null, file: null, agents: new Map() });
        return sessions.get(id);
      };
      const agent = (sid, name) => {
        const s = touch(sid);
        if (!s.agents.has(name)) s.agents.set(name, { name, role: null, kind: null, id: null, file: null, ticks: 0, findings: 0, cost: 0, end: null, movedFrom: null });
        return s.agents.get(name);
      };
      // Events written before every line carried its own session are not attributed by
      // guesswork — they are counted and named, so a gap is visible instead of silently
      // becoming someone else's history.
      const unstamped = all.filter((e) => !e.session).length;
      for (const e of all.filter((x) => x.session)) {
        const sid = e.session;
        if (e.kind === "main.registered") { const s = touch(e.sessionId ?? sid); s.started = s.started ?? e.ts; if (e.sessionFile) s.file = e.sessionFile; }
        else if (e.kind === "main.stopped") touch(e.sessionId ?? sid).ended = e.ts;
        if (!e.peer) continue;
        const owner = e.parent ?? e.parentSessionId ?? e.session ?? sid;
        const a = agent(owner, e.peer);
        if (e.kind === "peer.spawned") { a.role = e.role ?? a.role; a.kind = e.mode ?? a.kind; }
        if (e.kind === "peer.session") { a.id = e.peerSessionId ?? a.id; a.file = e.peerSessionFile ?? a.file; }
        if (e.kind === "tick.issued") a.ticks += 1;
        if (e.kind === "finding.delivered") a.findings += 1;
        if (e.kind === "peer.usage") a.cost += Number(e.costUsd ?? 0);
        if (["peer.stopped", "peer.killed", "peer.suspended"].includes(e.kind)) a.end = e.kind.replace("peer.", "");
        if (e.kind === "peer.attached") a.movedFrom = e.fromSession ?? a.movedFrom;
      }
      for (const s of sessions.values()) if (!s.file) s.file = fileOf(s.id);
      for (const s of sessions.values()) for (const a of s.agents.values()) if (!a.id) { const r = roster.find((x) => x.name === a.name); if (r) { a.id = r.peerSessionId; a.file = a.file ?? r.peerSessionFile; a.role = a.role ?? r.role; a.kind = a.kind ?? r.mode; } }
      let list = [...sessions.values()].filter((s) => s.started || s.agents.size);
      if (wantSession) list = list.filter((s) => s.id.startsWith(wantSession));
      if (wantPeer) list = list.filter((s) => [...s.agents.keys()].some((n) => n.includes(wantPeer)));
      list.sort((a, b) => String(a.started ?? "").localeCompare(String(b.started ?? "")));
      if (argv.includes("--json")) {
        console.log(JSON.stringify({ project, unattributableEvents: unstamped, sessions: list.map((s) => ({ ...s, agents: [...s.agents.values()] })) }, null, 2));
        return;
      }
      console.log(`project ${path.basename(project)}  (${project})`);
      console.log(`${list.length} pi session(s) on record${unstamped ? ` · ${unstamped} older event(s) predate per-event attribution and are not shown` : ""}\n`);
      for (const s of list) {
        const span = `${(s.started ?? "?").slice(11, 19)} → ${s.ended ? s.ended.slice(11, 19) : "still running"}`;
        console.log(`pi ${s.id}  ${span}`);
        console.log(`   transcript: ${s.file ? s.file.replace(os.homedir(), "~") : "(not recorded)"}`);
        if (s.agents.size === 0) console.log("   (spawned no agents)");
        for (const a of [...s.agents.values()]) {
          console.log(`   └─ ${a.name}  ${a.role ?? "?"}${a.kind ? ` · ${a.kind}` : ""} · ${a.ticks} tick(s) · ${a.findings} finding(s) · $${a.cost.toFixed(3)}${a.end ? ` · ${a.end}` : ""}${a.movedFrom ? ` · moved here from ${String(a.movedFrom).slice(0, 8)}` : ""}`);
          console.log(`        transcript: ${a.file ? a.file.replace(os.homedir(), "~") : "(not recorded)"}`);
        }
        console.log("");
      }
      return;
    }
    case "findings": {
      const who = argv[0];
      const found = readLedgerTail(5000).filter(
        (e) => (e.kind === "finding.delivered" || e.kind === "inbox.delivered") && e.body && (!who || e.peer === who),
      );
      if (found.length === 0) {
        console.log(who ? `no recorded findings for ${who}` : "no recorded findings");
        return;
      }
      for (const e of found) {
        console.log(`— ${e.peer} · ${e.priority}${e.tick ? ` · tick ${e.tick}` : ""} · ${e.ts}`);
        console.log(`  ${e.body}\n`);
      }
      return;
    }
    case "launch": {
      // Role is OPTIONAL. The first word is PASSED as the role, but the session
      // side decides: if it is not a known role it is folded back into the
      // instruction and a role is written on the fly (operator 2026-08-06).
      const role = argv[0] && !argv[0].startsWith("--") ? argv.shift() : undefined;
      const tick = takeFlag("--tick");
      const context = takeFlag("--context");
      const watch = takeFlag("--watch");
      const authority = takeFlag("--authority");
      const fallback = takeFlag("--fallback");
      const skills = takeFlag("--skills");
      const untilFile = takeFlag("--until-file");
      const untilExit0 = takeFlag("--until-exit0");
      const maxCycles = takeFlag("--max-cycles");
      // `launch` accepted --model everywhere except here, so the flag and its value were
      // swallowed into the instruction: an agent's recorded task read "stand by --model
      // anthropic-ghaf/claude-fable-5". Caught by an agent quoting its own task back.
      const modelRef = takeFlag("--model");
      // Manual override of the contract's kind, same two switches the slash surface has.
      const kind = takeSwitch("--mission") ? "mission" : takeSwitch("--task") ? "task" : undefined;
      const task = argv.join(" ").trim();
      if (!role && !task) fail("launch needs an instruction (a role name is optional)");
      const leftoverFlag = argv.find((a) => a.startsWith("--"));
      if (leftoverFlag) fail(`launch does not know the option "${leftoverFlag}" — it would have become part of the instruction. Run: pi-peer help`);
      await run({ action: "launch", role, task, kind, model: modelRef, tickMinutes: tick ? Number(tick) : undefined, context, watchCwd: watch ? path.resolve(watch) : undefined,
        authority, fallback, skills, untilFile, untilExit0, maxCycles: maxCycles ? Number(maxCycles) : undefined });
      return;
    }
    case "task": {
      // TASK kind: not ticked. Same optional-role rule as launch.
      const role = argv[0] && !argv[0].startsWith("--") ? argv.shift() : undefined;
      const context = takeFlag("--context");
      const watch = takeFlag("--watch");
      const authority = takeFlag("--authority");
      const worktree = takeSwitch("--worktree");
      const gate = takeFlag("--gate");
      const fallback = takeFlag("--fallback");
      const skills = takeFlag("--skills");
      const job = argv.join(" ").trim();
      if (!role && !job) fail("task needs a job (a role name is optional)");
      await run({ action: "launch", kind: "task", role, task: job, context, authority, worktree, gate, fallback, skills,
        watchCwd: watch ? path.resolve(watch) : undefined });
      return;
    }
    case "mission": {
      // A ticked WORKER: same rhythm as a watch, but its own work is the point.
      const role = argv[0] && !argv[0].startsWith("--") ? argv.shift() : undefined;
      const tick = takeFlag("--tick");
      const context = takeFlag("--context");
      const authority = takeFlag("--authority");
      const fallback = takeFlag("--fallback");
      const skills = takeFlag("--skills");
      const charge = argv.join(" ").trim();
      if (!role && !charge) fail("mission needs a charge (a role name is optional)");
      await run({ action: "launch", kind: "mission", role, task: charge,
        tickMinutes: tick ? Number(tick) : undefined, context, authority, fallback, skills });
      return;
    }
    case "wave": {
      // pi-peer wave [role] key=job key=job … — N tasks as one unit, one report.
      const role = argv[0] && !argv[0].startsWith("--") && !argv[0].includes("=") ? argv.shift() : undefined;
      const context = takeFlag("--context");
      const authority = takeFlag("--authority");
      const gate = takeFlag("--gate");
      const items = argv.filter((a) => a.includes("=")).map((a) => {
        const i = a.indexOf("=");
        return { key: a.slice(0, i).trim(), task: a.slice(i + 1).trim() };
      });
      if (items.length < 2) fail("a wave needs at least two tasks, given as key=job (use `task` for one)");
      await run({ action: "wave", role, items, context, authority, gate });
      return;
    }
    case "roles": {
      // Where the templates live, answered by the product instead of the source.
      await run({ action: "roles" }, { timeoutMs: 20_000 });
      return;
    }
    case "cost": {
      // What the crew has cost, from durable state — the sum of what each agent
      // reported, reconciled against the ledger's own usage entries.
      const roster = readRoster().filter((e) => e.kind !== "main");
      const led = readLedgerTail(20000);
      const fromLedger = {};
      for (const e of led) {
        if (e.kind === "peer.usage" && e.peer) {
          fromLedger[e.peer] = { input: e.totalInput ?? 0, output: e.totalOutput ?? 0, costUsd: e.totalCostUsd ?? 0 };
        }
      }
      let ti = 0, to = 0, tc = 0, mismatches = 0;
      const rows = [];
      for (const e of roster) {
        const u = e.usage ?? { input: 0, output: 0, costUsd: 0 };
        const l = fromLedger[e.name];
        const agrees = !l || (l.input === u.input && l.output === u.output && Math.abs(l.costUsd - u.costUsd) < 1e-6);
        if (!agrees) mismatches++;
        ti += u.input; to += u.output; tc += u.costUsd;
        rows.push(`  ${e.name.padEnd(16)} ${String(e.mode ?? "watch").padEnd(6)} ↑${String(u.input).padStart(8)} ↓${String(u.output).padStart(7)} $${u.costUsd.toFixed(4).padStart(9)}${agrees ? "" : "   (disagrees with the ledger)"}`);
      }
      console.log(`CREW COST · ${roster.length} agent(s) · project ${cwd}`);
      console.log(rows.join("\n") || "  (no agents yet)");
      console.log(`  ${"TOTAL".padEnd(16)} ${"".padEnd(6)} ↑${String(ti).padStart(8)} ↓${String(to).padStart(7)} $${tc.toFixed(4).padStart(9)}`);
      if (tc === 0 && (ti + to) > 0) console.log(`  this provider reports no price — the crew has spent ${ti + to} tokens at a reported cost of $0`);
      console.log(mismatches === 0
        ? `  every agent's total matches the ledger's own record`
        : `  ${mismatches} agent(s) disagree with the ledger — inspect .pi/peer-agent/events.jsonl`);
      return;
    }
    case "doctor": {
      // One read-only pass over everything that usually goes wrong.
      const problems = [], notes = [];
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8"));
      notes.push(`version        pi-peer-agent ${pkg.version} (this CLI)`);
      // config
      const cfgPath = path.join(os.homedir(), ".pi", "agent", "peer-agent.json");
      let cfg = null;
      if (fs.existsSync(cfgPath)) {
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); notes.push(`config         ${cfgPath} parses`); }
        catch (err) { problems.push(`config         ${cfgPath} is not valid JSON: ${String(err).slice(0, 120)}`); }
        const known = new Set(["toggleKey","focusKey","focusAliases","resizeUpKeys","resizeDownKeys","render","placement","panelHeightRatio","worktrees","maxPeers","backoff","talk","focusOnOpen","model","tick"]);
        for (const k of Object.keys(cfg ?? {})) if (!known.has(k)) notes.push(`config         unknown key "${k}" (ignored)`);
      } else notes.push("config         none (defaults)");
      // state
      if (!fs.existsSync(stateDir)) notes.push("state          no crew has run in this project yet");
      else {
        const roster = readRoster();
        if (fs.existsSync(rosterPath) && roster.length === 0) problems.push(`roster         ${rosterPath} is empty or unreadable`);
        else notes.push(`roster         ${roster.length} entr${roster.length === 1 ? "y" : "ies"}`);
        const orphans = roster.filter((e) => isOrphaned(e, roster));
        if (orphans.length) problems.push(`orphans        ${orphans.length}: ${orphans.map((o) => o.name).join(", ")} — no live session ticks these (resume or stop them)`);
        else notes.push("orphans        none");
        const led = readLedgerTail(50);
        if (!fs.existsSync(ledgerPath)) notes.push("ledger         none yet");
        else if (led.length === 0) problems.push(`ledger         ${ledgerPath} has no readable entries`);
        else {
          const parts = ledgerParts();
          const bytes = parts.reduce((n, f) => n + fs.statSync(f).size, 0);
          notes.push(`ledger         readable, last entry ${led[led.length - 1]?.ts ?? "?"} · ${parts.length} file(s) · ${(bytes / 1024).toFixed(0)} KB`);
          // A per-session counter exists to notice missing lines. Check each session's
          // run of numbers: several sessions interleave in one file, so only a
          // per-session run can be continuous.
          const all = readLedgerTail(1000000);
          const runs = new Map();
          let unnumbered = 0;
          for (const e of all) {
            if (typeof e.sessionSeq !== "number" || !e.session) { unnumbered += 1; continue; }
            if (!runs.has(e.session)) runs.set(e.session, []);
            runs.get(e.session).push(e.sessionSeq);
          }
          const broken = [];
          for (const [sid, nums] of runs) {
            nums.sort((a, b) => a - b);
            const gaps = [];
            for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1 && nums[i] !== nums[i - 1]) gaps.push(`${nums[i - 1]}→${nums[i]}`);
            if (nums[0] !== 1) gaps.unshift(`starts at ${nums[0]}`);
            if (gaps.length) broken.push(`${sid.slice(0, 8)} (${gaps.slice(0, 3).join(", ")})`);
          }
          if (broken.length) problems.push(`ledger gaps    ${broken.length} session(s) are missing events: ${broken.slice(0, 4).join(" · ")} — lines were removed or a write was lost`);
          else notes.push(`ledger runs    ${runs.size} session(s), every event accounted for${unnumbered ? ` · ${unnumbered} line(s) written before per-session numbering` : ""}`);
          const loose = parts.concat([path.join(stateDir, "roster.json"), path.join(stateDir, "panel-state.json")])
            .filter((f) => fs.existsSync(f) && (fs.statSync(f).mode & 0o077) !== 0);
          if (loose.length) problems.push(`permissions    ${loose.length} file(s) readable by other users: ${loose.map((f) => path.basename(f)).join(", ")} — these hold your agents' words and drafts`);
          else notes.push("permissions    private to you (0600)");
        }
        // write lock
        const lockFile = path.join(stateDir, "write.lock");
        if (fs.existsSync(lockFile)) {
          let held = null;
          try { held = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { /* unreadable */ }
          let alive = false;
          try { process.kill(held?.pid, 0); alive = true; } catch (err) { alive = err?.code === "EPERM"; }
          if (alive) notes.push(`write lock     held by ${held?.holder} (pid ${held.pid}) — another writer is working`);
          else problems.push(`write lock     left behind by a dead process (${held?.holder ?? "unreadable"}, pid ${held?.pid}) — the next writer will take it over`);
        } else notes.push("write lock     free");
      }
      console.log(`PEER-AGENT DOCTOR · project ${cwd}`);
      for (const n of notes) console.log(`  ok    ${n}`);
      for (const p of problems) console.log(`  FAULT ${p}`);
      console.log(problems.length === 0 ? "  nothing needs your attention" : `  ${problems.length} thing(s) need your attention`);
      process.exit(problems.length === 0 ? 0 : 1);
    }
    case "authority": {
      const who = argv.shift();
      const level = argv.shift();
      if (!who) {
        for (const e of readRoster().filter((r) => r.kind !== "main")) {
          console.log(`  ${e.name}  ${e.authority ?? "read-only"}`);
        }
        console.log("  change with: pi-peer authority <name> <read-only|write|shell>");
        return;
      }
      if (!level || !["read-only", "write", "shell"].includes(level)) {
        fail(`usage: pi-peer authority ${who} <read-only|write|shell>`);
      }
      await run({ action: "authority", name: who, level });
      return;
    }
    case "ask-parent": {
      // Reach a MAIN session from outside, addressed by its session id (or a
      // unique prefix, as shown by `census`). Delivery is an injection into
      // that session's live turn -- it answers there, in its own session, not
      // here; so this returns as soon as the running session accepts it.
      const target = argv.shift();
      const message = argv.join(" ");
      if (!target || !message) fail("usage: pi-peer ask-parent <session-id-or-prefix> <message…>");
      const mains = readRoster().filter((e) => e.kind === "main");
      const hit = mains.find((m) => m.peerSessionId === target || m.peerSessionId.startsWith(target) || m.name === target);
      if (!hit) fail(`no registered main session matching "${target}" — run: pi-peer --cwd ${cwd} census`);
      if (hit.status === "stopped") console.error(`warning: ${hit.name} is marked stopped — queuing anyway, it will be picked up if that session returns`);
      await run({ action: "ask", target: hit.peerSessionId, message }, { timeoutMs: 30_000, quietOk: true });
      return;
    }
    case "tell-all": {
      const message = argv.join(" ").trim();
      if (!message) fail("tell-all needs something to say");
      await run({ action: "tell-all", message }, { timeoutMs: 120_000, quietOk: true });
      return;
    }
    case "rules": {
      const sub = argv[0];
      if (sub === "--why") {
        // --to-project asks the question about a recipient in ANOTHER project, which is
        // the verdict a cross-project message gets. Without it the answer can only ever be
        // about this project, and "can A reach B?" is exactly the question worth asking.
        const tp = argv.indexOf("--to-project");
        const otherProject = tp === -1 ? null : argv[tp + 1];
        if (tp !== -1) argv.splice(tp, 2);
        const [, from, to] = argv;
        if (!from || !to) fail('usage: pi-peer rules --why <from> <to>   e.g. --why peer:observer-watch-1 peer:reviewer-once-1');
        const roster = readRoster();
        const nameOf = (s) => (s.includes(":") ? s.split(":")[1] : s);
        const kindOf = (s) => (s.startsWith("parent") ? "parent" : "peer");
        const projOf = (s) => otherProject ? path.resolve(otherProject) : (roster.find((e) => e.name === nameOf(s))?.project ?? cwd);
        const attempt = { from: kindOf(from), fromName: nameOf(from), fromProject: cwd, to: kindOf(to), toName: nameOf(to), toProject: projOf(to) };
        const verdict = judge(attempt, loadRules(cwd));
        console.log(verdict.allowed
          ? `allowed by ${JSON.stringify(verdict.by?.rule)} (${verdict.by?.file})`
          : refusalText(attempt, verdict));
        return;
      }
      if (sub === "deny") {
        // Narrowing is safe and stays a command. Widening is not offered: a rule grants an
        // agent reach into another project, and an elevated agent must not be able to
        // grant itself more by running a command.
        const [, from, to] = argv;
        if (!from || !to) fail("usage: pi-peer rules deny <from> <to>");
        const file = projectRulesFile(cwd);
        const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
        cur.talk = [...(cur.talk ?? []), { from, to, in: cwd, to_project: cwd, deny: true }];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cur, null, 2));
        console.log(`denied ${from} → ${to} in ${cwd} (${file})`);
        return;
      }
      if (sub === "allow") {
        fail(
          `pi-peer does not grant reach. A rule that widens access is a human edit, so an ` +
            `elevated agent cannot grant itself more by running a command.\n` +
            `  Edit ${machineRulesFile()} and add to "talk":\n` +
            `    { "from": "peer", "to": "peer", "in": "${cwd}", "to_project": "<the other project>", "allow": true }`,
        );
      }
      for (const { rule, file, kind } of effectiveRules(cwd)) {
        console.log(`  ${kind.padEnd(5)} ${String(rule.from).padEnd(8)} → ${String(rule.to).padEnd(8)} in ${rule.in} → ${rule.to_project}   (${file})`);
      }
      const { project } = loadRules(cwd);
      for (const r of project.refused) console.error(`  REFUSED in ${project.file}: ${r.why}`);
      return;
    }
    case "audit": {
      // ledgerParts() returns FILE PATHS, not their contents — splitting a path on
      // newlines yields one useless line and an empty audit that looks like a quiet project.
      const rows = ledgerParts()
        .flatMap((f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n"); } catch { return []; } })
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && ["talk.judged", "send.sent", "send.delivered", "send.refused", "ask.sent", "finding.delivered", "finding.refused", "peer.retasked"].includes(e.kind));
      if (rows.length === 0) { console.log("no messages recorded in this project yet"); return; }
      for (const e of rows) {
        const when = String(e.at ?? "").slice(11, 19);
        if (e.kind === "talk.judged") console.log(`  ${when}  ${e.from} → ${e.to}   ${e.allowed ? "allowed" : "REFUSED"}  by ${e.by ? JSON.stringify(e.by) : "no rule"}`);
        else if (e.kind === "send.refused") console.log(`  ${when}  ${e.from} → ${e.to}   REFUSED  ${e.why}`);
        else if (e.kind === "send.delivered") console.log(`  ${when}  ${e.from} → ${e.to}   delivered (${e.status})`);
        else if (e.kind === "send.sent") console.log(`  ${when}  ${e.from} → ${e.to}   sent (${e.chars} chars)`);
        else if (e.kind === "finding.delivered") console.log(`  ${when}  ${e.peer} → its session   finding delivered${e.via ? ` (${e.via})` : ""}`);
        else if (e.kind === "finding.refused") console.log(`  ${when}  ${e.peer} → its session   REFUSED  ${e.why}`);
        else if (e.kind === "peer.retasked") console.log(`  ${when}  operator → ${e.peer}   new standing task (${String(e.task ?? "").slice(0, 40)})`);
        else console.log(`  ${when}  ${e.from ?? "?"} → ${e.peer ?? "?"}   asked (${e.chars ?? "?"} chars)`);
      }
      return;
    }
    case "ask": {
      const name = argv.shift() ?? fail("ask needs an agent name");
      const message = argv.join(" ").trim();
      if (!message) fail("ask needs something to say");
      await run({ action: "ask", name, message }, { timeoutMs: 120_000, quietOk: true });
      return;
    }
    case "retask": {
      const name = argv.shift() ?? fail("retask needs a peer name");
      const tick = takeFlag("--tick");
      const task = argv.join(" ").trim();
      if (!task) fail("retask needs a task");
      await run({ action: "retask", name, task, tickMinutes: tick ? Number(tick) : undefined });
      return;
    }
    case "tick": {
      const name = argv.shift() ?? fail("tick needs a peer name");
      const minutes = Number(argv.shift());
      if (!Number.isFinite(minutes) || minutes < 1) fail("tick needs minutes >= 1");
      await run({ action: "tick", name, minutes });
      return;
    }
    case "models": {
      // List pi's available models (the panel's exact source), optionally filtered.
      await run({ action: "models", query: argv.join(" ").trim() });
      return;
    }
    case "model": {
      const name = argv.shift() ?? fail("model needs a peer name");
      const ref = argv.join(" ").trim();
      // One flow for every form: resolve against the live session's model list
      // (the same set the panel shows). Exact/unique refs apply directly;
      // bare/ambiguous forms become a numbered picker on a TTY.
      const ack = await run({ action: "models", query: ref }, { quietOk: true, silentReply: true });
      const models = String(ack.reply ?? "").split("\n").filter(Boolean);
      if (models.length === 0) fail(`no model matching "${ref}" among pi's available models`);
      let choice = models[0];
      if (models.length > 1) {
        console.log(ref ? `"${ref}" matches ${models.length} models:` : `${models.length} models available:`);
        models.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}  ${m}`));
        if (!process.stdin.isTTY) {
          fail(`ambiguous — not a TTY, so no picker; re-run with one of the models above`);
        }
        const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`pick 1-${models.length} for ${name} (empty cancels): `)).trim();
        rl.close();
        const n = Number.parseInt(answer, 10);
        if (!answer) { console.log("cancelled — nothing changed"); return; }
        if (!Number.isInteger(n) || n < 1 || n > models.length) fail(`"${answer}" is not 1-${models.length} — nothing changed`);
        choice = models[n - 1];
      }
      await run({ action: "model", name, ref: choice });
      return;
    }
    case "kill": {
      const name = argv.shift() ?? fail("kill needs a peer name");
      await run({ action: "kill", name });
      return;
    }
    case "attach": {
      const name = argv.shift() ?? fail("attach needs the name of an orphaned agent");
      await run({ action: "attach", name });
      return;
    }
    case "stop": {
      const name = argv.shift() ?? fail("stop needs a peer name or 'all'");
      await run({ action: "stop", name });
      return;
    }
    default:
      console.log(HELP);
      process.exit(verb ? 1 : 0);
  }
}

main().catch((err) => fail(String(err)));
