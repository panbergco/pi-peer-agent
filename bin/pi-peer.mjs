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

const stateDir = path.join(cwd, ".pi", "peer-agent");
const controlDir = path.join(stateDir, "control");
const ledgerPath = path.join(stateDir, "events.jsonl");
const rosterPath = path.join(stateDir, "roster.json");

const verb = argv.shift();

function readRoster() {
  try {
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return [];
  }
}

function readLedgerTail(n = 2000) {
  try {
    return fs
      .readFileSync(ledgerPath, "utf8")
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

async function run(cmd, { timeoutMs = 30_000, quietOk = false } = {}) {
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
  if (ack.reply) console.log(`\n${ack.reply}`);
  return ack;
}

const HELP = `pi-peer — control a project's resident peer crew from the shell

usage: pi-peer [--cwd <dir>] <command>

  list                                     crew overview (no live session needed)
  findings [name]                          delivered findings from the ledger (no session needed)
  launch <role> <task…> [--tick <min>] [--context fork|compacted|fresh] [--watch <dir>]
         [--until-file <path> | --until-exit0 '<cmd>'] [--max-cycles N]   # MISSION mode
  talk <name> <message…>                   send a message, print the peer's reply
  retask <name> <task…> [--tick <min>]
  tick <name> <minutes>                    change a peer's interval
  model <name> <provider/model|substring>  switch a peer's model
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
        const m = e.mode === "mission" ? ` [mission ${e.cycles ?? 0}/${e.objective?.maxCycles ?? 20} until ${e.objective?.kind}:${e.objective?.value}]` : "";
        console.log(
          `${e.name.padEnd(14)} ${e.role.padEnd(18)} ${String(e.status).padEnd(10)} tick ${String(Math.round((e.tickBaseS ?? 300) / 60) + "m").padEnd(5)}${u}${m} · ${e.task}`,
        );
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
      const role = argv.shift() ?? fail("launch needs a role — see the roles section of /peers list");
      const tick = takeFlag("--tick");
      const context = takeFlag("--context");
      const watch = takeFlag("--watch");
      const untilFile = takeFlag("--until-file");
      const untilExit0 = takeFlag("--until-exit0");
      const maxCycles = takeFlag("--max-cycles");
      const task = argv.join(" ").trim();
      if (!task) fail("launch needs a task");
      await run({ action: "launch", role, task, tickMinutes: tick ? Number(tick) : undefined, context, watchCwd: watch ? path.resolve(watch) : undefined,
        untilFile, untilExit0, maxCycles: maxCycles ? Number(maxCycles) : undefined });
      return;
    }
    case "talk": {
      const name = argv.shift() ?? fail("talk needs a peer name");
      const message = argv.join(" ").trim();
      if (!message) fail("talk needs a message");
      await run({ action: "talk", name, message }, { timeoutMs: 120_000, quietOk: true });
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
    case "model": {
      const name = argv.shift() ?? fail("model needs a peer name");
      const ref = argv.join(" ").trim();
      if (!ref) fail("model needs a model ref (provider/id or substring)");
      await run({ action: "model", name, ref });
      return;
    }
    case "kill": {
      const name = argv.shift() ?? fail("kill needs a peer name");
      await run({ action: "kill", name });
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
