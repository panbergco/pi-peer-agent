/** Peer runtime — resident sessions, tick engine, verdicts, push delivery.
 *  Spec: docs/peer-agent-spec.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMode, ContextMode, Finding, Handoff, Objective, PaneEntry, PeerConfig, PeerRole, PeerStatus, Priority, RosterEntry, Authority } from "./types.js";
import { withWriteLock } from "./writelock.js";
import { objectiveMet, parseHandoff, runGate, priorityRank, shortId, uid, AUTHORITY_TOOLS, DEFAULT_AUTHORITY } from "./types.js";
import { appendEvent, isOrphaned, mutateRoster, readRoster, upsertAgentsBlock } from "./state.js";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { judge, loadRules, reachableProjects, refusalText, type TalkAttempt } from "./talkrules.mjs";
import { rhythmOf } from "./roles.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Peer {
  name: string;
  role: PeerRole;
  task: string;
  contextMode: ContextMode;
  modelLabel: string;
  address: string;
  session: any; // AgentSession
  sessionId: string;
  sessionFile: string;
  status: PeerStatus;
  tickCount: number;
  quietStreak: number;
  backoffIdx: number;
  nextTickAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
  /** Watermark into the parent session's entry list (delta detection). */
  watermark: number;
  pane: PaneEntry[];
  findings: Finding[];
  pendingRetask: string | null;
  /** The role FILE's terms as last read. Compared against the file at recovery to
   *  notice a contract edited under a running agent — and not against the live role,
   *  which carries runtime overrides and would re-report the same change forever. */
  fileTerms?: { kind?: string; authority?: string; tick: number; priorityCeiling: string; context: string };
  /** Delivery receipts queued for the peer's next tick prompt. */
  pendingReceipts: string[];
  /** Watch directory: file tools rooted here when set (E1, spec 12.1). */
  watchCwd?: string;
  /** Cumulative usage across ticks and answers: a watch has a visible bill. */
  usage: { input: number; output: number; costUsd: number };
  /** TASK kind only: the structured handoff its single engagement produced. */
  handoff?: Handoff;
  /** Models still available to fall back to when a turn fails at the provider. */
  fallbackChain?: string[];
  /** TASK kind only: membership in a wave — several tasks launched together, each
   *  with a stable key, reported to the main agent as ONE completion. */
  wave?: { id: string; key: string };
  /** TASK kind only: the acceptance gate the FRAMEWORK must see pass before this
   *  task may retire. A task cannot finish on its own claim. */
  gate?: string;
  gateAttempts?: number;
  gatePassed?: boolean;
  /** Agent mode: a watch ticks forever, a goal ends. */
  mode: AgentMode;
  objective?: Objective;
  cycles: number;
  unsub: (() => void) | null;
  startedAt: string;
}

const PANE_CAP = 400;
/** How many extra tool-using turns a TASK gets before its handoff is demanded. */
const TASK_TURN_BUDGET = 12;
/** How many times a gated task may fail its acceptance check and try again. */
const TASK_GATE_ATTEMPTS = 3;

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** Split a finding body into prose + referenced files.
 *  A trailing `REFS: a.ts, dir/b.md` line names what the finding is ABOUT, giving
 *  consumers mechanical targets. Paths must be repo-relative: absolute paths and
 *  traversal are dropped (a finding can never point a consumer outside the tree). */
export function splitRefs(body: string): { body: string; refs: string[] } {
  const m = body.match(/\n?\s*REFS\s*:\s*([^\n]*)\s*$/i);
  if (!m) return { body, refs: [] };
  const refs = (m[1] ?? "")
    .split(/[,\s]+/)
    .map((p) => p.trim().replace(/^['"`]|['"`,.]+$/g, ""))
    .filter((p) => p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0"));
  return { body: body.slice(0, m.index).trim(), refs: [...new Set(refs)] };
}

/** Serialize parent-session entries appended since the watermark. */
function serializeDelta(entries: any[], from: number, cap: number): string {
  const parts: string[] = [];
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom_message") {
      if (e.customType === "peer-finding") continue; // never feed peers their siblings' pushes
      continue;
    }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") {
      const t = textOfBlocks(m.content).trim();
      if (t) parts.push(`[User]: ${t.slice(0, 1500)}`);
    } else if (m.role === "assistant") {
      const texts: string[] = [];
      const tools: string[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "text" && b.text) texts.push(b.text);
          else if (b?.type === "toolCall") {
            const args = JSON.stringify(b.arguments ?? {});
            tools.push(`${b.name}(${args.length > 160 ? args.slice(0, 160) + "…" : args})`);
          }
        }
      }
      if (texts.length) parts.push(`[Assistant]: ${texts.join("\n").slice(0, 2000)}`);
      if (tools.length) parts.push(`[Assistant tool calls]: ${tools.join("; ")}`);
    } else if (m.role === "toolResult") {
      const t = textOfBlocks(m.content).trim();
      if (t) parts.push(`[Tool result]: ${t.slice(0, 400)}${t.length > 400 ? ` …(+${t.length - 400} chars)` : ""}`);
    }
  }
  let out = parts.join("\n");
  if (out.length > cap) out = `…(earlier delta trimmed)\n${out.slice(out.length - cap)}`;
  return out;
}

const PROTOCOL = `Respond with your working notes (optional, brief), then END your reply with EXACTLY ONE verdict line:
QUIET
or
FINDING[info|steering|interrupt]: <one self-contained, actionable paragraph>
QUIET means: nothing worth the main agent's attention. Findings interrupt a working agent — they must earn it.
Your watch is STANDING: you are a long-running peer, not a one-off task. Never announce completion,
never stop yourself, never wind down — "the work seems finished" is itself just QUIET. Only the
operator or the main agent ends your watch.
DIRECT MESSAGES: replies stay private between you and the sender UNLESS you end the reply with a
FINDING[...] line — that is your ONLY way to push something to the main agent on demand (e.g. when
asked to relay or alert). You have no other relay mechanism; never claim to have delivered anything
without emitting that line. If your finding is ABOUT specific files, end it with a line: REFS: path/one.ts, path/two.md
(repo-relative paths, comma-separated) — they are parsed out as machine-readable targets and
stripped from your prose. Delivery receipts for your findings arrive in your next tick prompt;
you can also verify any delivery yourself in .pi/peer-agent/events.jsonl (finding.delivered).`;

  /** The crew an agent is allowed to know about: the agents its own parent launched in
 *  its own project, itself excluded. Built from the same roster the panel reads, so the
 *  two can never disagree about who exists. */
/** Who sent a message. Widening this to a plain string would accept anything, including a
 *  sender that never existed; the template shape keeps "an agent, by name" checkable. */
export type Sender = "operator" | "main-agent" | `peer:${string}`;

/** Hand a message to another project's live session. Its own session applies it and
 *  writes the reply back beside the request — the same control channel the command line
 *  uses, because a second mechanism for the same crossing is a second thing to keep true. */
async function deliverAcrossProjects(project: string, to: string, message: string, from: string): Promise<{ status: "ok" | "busy" | "missing"; reply?: string }> {
  const dir = joinPath(project, ".pi", "peer-agent", "control");
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(joinPath(dir, `${id}.json`), JSON.stringify({ id, action: "ask", name: to, message, from }, null, 2));
  const ackFile = joinPath(dir, "processed", `${id}.ack.json`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (existsSync(ackFile)) {
      try {
        const ack = JSON.parse(readFileSync(ackFile, "utf8"));
        return { status: ack.ok ? "ok" : "missing", reply: ack.reply ?? ack.message };
      } catch { /* still being written */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: "missing", reply: `no live session in ${project} picked the message up within 120s` };
}

export class PeerManager {
  peers = new Map<string, Peer>();
  private counters = new Map<string, number>();
  private ctx: ExtensionContext | null = null;
  onUpdate: (() => void) | null = null;

  constructor(
    private pi: ExtensionAPI,
    private config: PeerConfig,
  ) {}

  setCtx(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /** Agents still on watch/goal (panel + tick views). Ended agents remain
   *  in the roster/census but are no longer "active". */
  get active(): Peer[] {
    return [...this.peers.values()].filter((p) => !["stopped", "done", "exhausted", "retired"].includes(p.status));
  }

  /** Everything this session knows about, ended included (census). */
  get all(): Peer[] {
    return [...this.peers.values()];
  }

  private renderPending = false;
  private providerExtsCache: { extensions: any[]; runtime: any } | null | undefined;
  /** Model/auth runtime for peer sessions, carrying extension-registered
   *  providers so a peer can authenticate the same models the parent can. */
  private peerModelRuntime: any = null;

  /** Load auth/provider extensions for peer sessions (once, cached). Without
   *  these, models whose providers are registered by extensions (devin) fail
   *  with 'No API key' inside peers while working in the main session. */
  private async loadProviderExtensions(cwd: string): Promise<{ extensions: any[]; runtime: any } | null> {
    if (this.providerExtsCache !== undefined) return this.providerExtsCache;
    try {
      const { readFileSync, existsSync, readdirSync } = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      // Resolve pi's dist from its own process entry (jiti cannot
      // require.resolve the global package from our tree).
      let loader: any = null;
      const argvEntry = process.argv[1] ?? "";
      const marker = `${path.sep}@earendil-works${path.sep}pi-coding-agent${path.sep}`;
      const idx = argvEntry.indexOf(marker);
      const candidates: string[] = [];
      if (idx !== -1) candidates.push(path.join(argvEntry.slice(0, idx + marker.length), "dist", "core", "extensions", "index.js"));
      candidates.push("/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js");
      for (const c of candidates) {
        if (!existsSync(c)) continue;
        try {
          loader = await import(c);
          break;
        } catch {
          /* next candidate */
        }
      }
      if (!loader?.loadExtensions) {
        appendEvent(cwd, "provider-ext.error", { error: "loader unresolvable", candidates });
        this.providerExtsCache = null;
        return null;
      }
      const names = this.config.providerExtensions ?? [];
      const entryPaths: string[] = [];
      // A provider extension is wherever pi installed it. Looking only in the npm folder
      // meant a provider from a GIT package registered models the operator could select in
      // their own session, while every agent on that model failed each tick with "No API
      // key found for <provider>" — the provider was never loaded here at all.
      const roots: string[] = [path.join(os.homedir(), ".pi", "agent", "npm", "node_modules")];
      const gitRoot = path.join(os.homedir(), ".pi", "agent", "git");
      const walkGit = (dir: string, depth: number): void => {
        if (depth > 4 || !existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = path.join(dir, entry.name);
          if (existsSync(path.join(child, "package.json"))) roots.push(dir);
          else walkGit(child, depth + 1);
        }
      };
      walkGit(gitRoot, 0);
      for (const name of names) {
        for (const root of [...new Set(roots)]) {
          const pkgDir = path.join(root, name);
          const pkgJson = path.join(pkgDir, "package.json");
          if (!existsSync(pkgJson)) continue;
          const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
          for (const rel of pkg?.pi?.extensions ?? []) {
            const abs = path.resolve(pkgDir, rel);
            if (existsSync(abs) && !entryPaths.includes(abs)) entryPaths.push(abs);
          }
          break;
        }
      }
      appendEvent(cwd, "provider-ext.resolved", { requested: names, loaded: entryPaths.map((p) => path.basename(path.dirname(p))), missing: names.filter((n) => !entryPaths.some((p) => p.includes(`${path.sep}${n}${path.sep}`))) });
      if (entryPaths.length === 0) {
        this.providerExtsCache = null;
        return null;
      }
      const result = await loader.loadExtensions(entryPaths, cwd);
      for (const e of result.errors ?? []) appendEvent(cwd, "provider-ext.error", { path: e.path, error: String(e.error).slice(0, 200) });
      // Loading a provider extension only QUEUES its registration; something has
      // to apply it to a model/auth runtime. Peer sessions never had one, so a
      // peer on an extension-provided model (devin) failed every tick with
      // "No API key found for devin" while the parent session ran fine on the
      // same model. Build a runtime, apply the queued registrations, and hand it
      // to the peer's session.
      try {
        const sdk: any = await import("@earendil-works/pi-coding-agent");
        const rt = await sdk.ModelRuntime?.create?.({});
        if (rt) {
          for (const r of (result.runtime as any)?.pendingNativeProviderRegistrations ?? []) {
            try {
              rt.registerNativeProvider(r.provider);
            } catch (err) {
              appendEvent(cwd, "provider-ext.error", { provider: r?.provider?.id, error: String(err).slice(0, 160) });
            }
          }
          for (const r of (result.runtime as any)?.pendingProviderRegistrations ?? []) {
            try {
              rt.registerProvider(r.name, r.config);
            } catch (err) {
              appendEvent(cwd, "provider-ext.error", { provider: r?.name, error: String(err).slice(0, 160) });
            }
          }
          this.peerModelRuntime = rt;
          appendEvent(cwd, "provider-ext.runtime", {
            providers: [
              ...((result.runtime as any)?.pendingProviderRegistrations ?? []).map((r: any) => r.name),
              ...((result.runtime as any)?.pendingNativeProviderRegistrations ?? []).map((r: any) => r.provider?.id),
            ].filter(Boolean),
          });
        }
      } catch (err) {
        appendEvent(cwd, "provider-ext.error", { error: `model runtime: ${String(err).slice(0, 160)}` });
      }
      this.providerExtsCache = { extensions: result.extensions ?? [], runtime: result.runtime };
      appendEvent(cwd, "provider-ext.loaded", { count: result.extensions?.length ?? 0, names });
      return this.providerExtsCache;
    } catch (err) {
      appendEvent(cwd, "provider-ext.error", { error: String(err).slice(0, 200) });
      this.providerExtsCache = null;
      return null;
    }
  }

  /** Throttled: streaming fires per token, but the TUI repaints at most
   *  ~6 fps — higher rates on a large overlay read as flicker. */
  private notify(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      try {
        this.onUpdate?.();
      } catch {
        /* sidecar must never break the runtime */
      }
    }, 160);
  }

  private refreshRoster(cwd: string): void {
    // Roster reflects the WHOLE session crew, stopped included — a stopped
    // peer's identity, task, and resume path stay discoverable (recovery
    // ignores status 'stopped').
    const entries: RosterEntry[] = [...this.peers.values()].map((p) => ({
      name: p.name,
      role: p.role.name,
      address: p.address,
      peerSessionId: p.sessionId,
      peerSessionFile: p.sessionFile,
      parentSessionId: this.parentSessionId(),
      task: p.task,
      contextMode: p.contextMode,
      model: p.modelLabel,
      authority: p.role.authority ?? "read-only",
      // Provenance survives every roster refresh: without these, the launch-time record
      // was overwritten on the next tick and an agent became untraceable to its contract.
      ...(p.role.file ? { roleFile: p.role.file } : {}),
      ...(p.fileTerms ? { roleTerms: p.fileTerms } : {}),
      tickBaseS: p.role.tick,
      status: p.status,
      startedAt: p.startedAt,
      usage: { input: p.usage.input, output: p.usage.output, costUsd: Number(p.usage.costUsd.toFixed(6)) },
      mode: p.mode,
      cycles: p.cycles,
      ...(p.handoff ? { handoffSummary: p.handoff.summary } : {}),
      ...(p.gate ? { gate: p.gate, gatePassed: !!p.gatePassed, gateAttempts: p.gateAttempts ?? 0 } : {}),
      ...(p.wave ? { wave: p.wave.id, waveKey: p.wave.key } : {}),
      ...(p.objective ? { objective: p.objective } : {}),
      ...(p.watchCwd ? { watchCwd: p.watchCwd } : {}),
    }));
    this.mergeRoster(cwd, entries);
  }

  /** Where peer session files live: <default sessions dir>/peer-agent/. */
  private async peerSessionDir(cwd: string): Promise<string | undefined> {
    try {
      const path = await import("node:path");
      const parentFile = this.parentSessionFile();
      if (parentFile) return path.join(path.dirname(parentFile), "peer-agent");
      const { SessionManager }: any = await import("@earendil-works/pi-coding-agent");
      const probe = SessionManager.create(cwd);
      const f = probe?.getSessionFile?.();
      return f ? (await import("node:path")).join((await import("node:path")).dirname(f), "peer-agent") : undefined;
    } catch {
      return undefined;
    }
  }

  /** Shared session assembly for launch AND recovery: charter-as-system-
   *  prompt, provider-extensions-only loader, read-only tools. */
  /** Where am I? A peer with fresh context otherwise knows nothing about the
   *  project it serves (incident 2026-08-05: an architect peer could not name
   *  its own repository). Cheap, static, always included. */
  private projectPreamble(cwd: string, watchCwd?: string): string {
    const root = watchCwd ?? cwd;
    const lines: string[] = [`PROJECT YOU SERVE: ${root}`];
    try {
      const { existsSync, readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
      const { basename, join } = require("node:path") as typeof import("node:path");
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      lines[0] = `PROJECT YOU SERVE: ${basename(root)} (${root})`;
      try {
        const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 4000 }).trim();
        const remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 4000 }).trim();
        lines.push(`git: branch ${branch}${remote ? ` · origin ${remote}` : ""}`);
      } catch {
        /* not a git repo — fine */
      }
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") || ["\.pi", "\.github"].includes(e.name))
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      lines.push(`top level: ${entries.join(", ")}`);
      for (const doc of ["README.md", "AGENTS.md", "CLAUDE.md", "package.json"]) {
        const p = join(root, doc);
        if (!existsSync(p)) continue;
        const head = readFileSync(p, "utf8").split("\n").slice(0, 12).join("\n").slice(0, 600);
        lines.push(`--- ${doc} (first lines) ---\n${head}`);
      }
    } catch {
      /* preamble is best-effort — never block a launch */
    }
    return lines.join("\n");
  }

  private async assemblePeerSession(
    ctx: ExtensionContext,
    cwd: string,
    role: PeerRole,
    name: string,
    address: string,
    parentId: string,
    sm: any,
    wantedModel?: string,
    watchCwd?: string,
  ): Promise<{ session: any; model: any }> {
    const mod: any = await import("@earendil-works/pi-coding-agent");
    // Bare resource loader (btw-sidecar pattern): a peer session loads NO
    // ambient extensions/skills/agents-files — it is a monitor, not a second
    // operator cockpit — and its system prompt IS the role charter.
    // Skills are resolved before the prompt is composed so their instructions can be
    // carried in it, using pi's OWN formatter — an agent must see a skill exactly as
    // the operator's session would.
    let agentSkills: any[] = [];
    let skillsPrompt = "";
    if (role.skills?.length) {
      const { homedir } = await import("node:os");
      const found = mod.loadSkills({ cwd: watchCwd ?? cwd, agentDir: `${homedir()}/.pi/agent`, skillPaths: [], includeDefaults: true });
      const wanted = new Set(role.skills.map((x) => x.toLowerCase()));
      agentSkills = (found.skills ?? []).filter((sk: any) => wanted.has(String(sk.name).toLowerCase()));
      const missing = role.skills.filter((want) => !agentSkills.some((sk: any) => String(sk.name).toLowerCase() === want.toLowerCase()));
      appendEvent(cwd, "peer.skills", { peer: name, requested: role.skills, loaded: agentSkills.map((sk: any) => sk.name), ...(missing.length ? { missing } : {}) });
      if (missing.length) throw new Error(`skill not found: ${missing.join(", ")} — pi discovered ${(found.skills ?? []).length} skills in this project`);
      skillsPrompt = [
        `SKILLS AVAILABLE TO YOU: ${agentSkills.map((sk: any) => sk.name).join(", ")} — follow them when the work matches.`,
        mod.formatSkillsForPrompt ? mod.formatSkillsForPrompt(agentSkills) : "",
        ...agentSkills.map((sk: any) => {
          try {
            const { readFileSync } = require("node:fs") as typeof import("node:fs");
            return `--- SKILL ${sk.name} (${sk.filePath}) ---\n${readFileSync(sk.filePath, "utf8").slice(0, 8000)}`;
          } catch {
            return "";
          }
        }),
      ].filter(Boolean).join("\n\n");
    }
    const systemPrompt = [
      `You are ${name}, a resident PEER MONITOR (role: ${role.name}) bound to a main pi agent session (agent://pi/${parentId}).`,
      "You are not alone: the `crew` tool tells you which other agents this session is running in this project, and what each is doing, and the `send` tool speaks to one of them by name and brings back its reply. Use them before assuming you are the only one on a problem.",
      `Your address: ${address}. The roster of sibling peers lives at .pi/peer-agent/roster.json.`,
      "",
      role.charter,
      "",
      this.projectPreamble(cwd, watchCwd),
      "",
      // The prompt must state the CURRENT authority. It used to hardcode "you
      // cannot modify anything", so an elevated agent kept refusing to act even
      // once it held the tools -- tools alone do not change behaviour, the
      // charter does (operator: "I authorised it, it refused").
      ...((role.authority ?? DEFAULT_AUTHORITY) === "read-only"
        ? [
            `You have READ-ONLY tools (${role.tools.join(", ")}) — inspect the repository to verify suspicions before reporting. You cannot modify anything. If a task genuinely requires writing or running commands, say so and tell the operator they can raise your authority with: /peer authority ${name} write   (or shell). Do not pretend you can act, and do not refuse silently.`,
          ]
        : [
            `You have been ELEVATED to ${role.authority} authority by an explicit human action. Your tools are: ${role.tools.join(", ")}. You MAY modify files${role.authority === "shell" ? " and run commands" : ""} — strictly within ${watchCwd ?? cwd} and nowhere else. This is a deliberate grant: act on it when the task calls for it, keep changes minimal and reversible, and report what you changed. You are still a monitor: do not take on work nobody asked for.`,
          ]),
      ...(watchCwd && watchCwd !== cwd
        ? ["", `Your file tools are rooted at ${watchCwd} (your WATCH DIRECTORY) — relative paths resolve there, not at the main project root.`]
        : []),
      "",
      ...(skillsPrompt ? [skillsPrompt, ""] : []),
      PROTOCOL,
    ].join("\n");
    const providerExts = await this.loadProviderExtensions(cwd);
    const resourceLoader = {
      getExtensions: () => ({
        extensions: providerExts?.extensions ?? [],
        errors: [],
        runtime: providerExts?.runtime ?? mod.createExtensionRuntime(),
      }),
      getSkills: () => ({ skills: agentSkills, diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    let model: any = (ctx as any).model;
    if (wantedModel) {
      const [prov, ...rest] = wantedModel.split("/");
      model = (ctx as any).modelRegistry?.find?.(prov, rest.join("/")) ?? model;
    }
    const toolsCwd = watchCwd ?? cwd;
    // Tool set follows the role's DECLARED AUTHORITY. read-only is the default
    // and stays the default; write adds edit/write, shell adds command
    // execution. Everything is rooted at the agent's own directory, so an
    // elevated agent is elevated THERE and nowhere else -- project scoping
    // project scoping still bounds it.
    const authority: Authority = role.authority ?? DEFAULT_AUTHORITY;
    const built: any[] = [...mod.createReadOnlyTools(toolsCwd)];
    if (authority === "write" || authority === "shell") {
      if (mod.createEditTool) built.push(mod.createEditTool(toolsCwd));
      if (mod.createWriteTool) built.push(mod.createWriteTool(toolsCwd));
    }
    if (authority === "shell" && mod.createBashTool) built.push(mod.createBashTool(toolsCwd));
    const readOnly: any[] = built.filter((t: any) => role.tools.includes(t.name));
    // An agent could not learn that another agent existed: its toolbelt was its authority
    // set and nothing else. It can now ask who else is in its crew — its OWN parent's
    // agents in its OWN project, itself excluded. Reading only; addressing them is a
    // separate grant.
    // The agent's crew tools, built here because this is the only place they exist: one to
    // see who else this session is running in this project, one to speak to them. Both are
    // bounded by the same rule, written once, so the list and the send path cannot drift
    // apart about who counts as crew.
    const siblings = (): Array<Record<string, unknown>> => {
      const roster = readRoster(cwd);
      const here = resolvePath(cwd);
      return roster
        .filter((e) => e.kind !== "main" && e.name !== name && e.parentSessionId === parentId && resolvePath(e.project ?? here) === here)
        .map((e) => ({ name: e.name, role: e.role, kind: e.mode ?? "watch", state: isOrphaned(e, roster) ? "orphaned" : e.status, task: e.task }));
    };
      readOnly.push(
      {
        name: "crew",
        label: "crew",
        description:
          "Who else is working alongside you: the other agents launched by the same session, in this project. Returns each one's name, role, kind and current state. You cannot see agents belonging to another session or another project.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const list = siblings();
          appendEvent(cwd, "crew.listed", { peer: name, siblings: list.map((s) => s["name"]) });
          const text = list.length === 0
            ? "You are the only agent this session is running in this project."
            : JSON.stringify(list, null, 2);
          return { content: [{ type: "text", text }] };
        },
      },
      {
        name: "send",
        label: "send",
        description:
          "Send a message to another agent and get its reply. Give a name from the crew tool, or name@/path/to/project to reach an agent in another project (which needs a rule permitting it).",
        parameters: {
          type: "object",
          required: ["to", "message"],
          properties: {
            to: { type: "string", description: "The agent's name, exactly as the crew tool gives it" },
            message: { type: "string", description: "What you want to say" },
          },
          additionalProperties: false,
        },
        execute: async (_id: string, params: { to?: string; message?: string }) => {
          const to = String(params?.to ?? "").trim();
          const message = String(params?.message ?? "").trim();
          const refuse = (why: string) => {
            appendEvent(cwd, "send.refused", { from: name, to, why });
            return { content: [{ type: "text", text: `Refused: ${why}` }] };
          };
          if (!to || !message) return refuse("a message needs both a recipient and something to say");
          // A name is only unique inside a project, so an agent elsewhere may be named
          // `name@/path/to/project`. Without that, two projects each running an
          // observer-watch-1 are indistinguishable — and a send to the far one was refused
          // as a send to yourself.
          const [bareTo, qualifier] = to.split("@");
          if (!qualifier && to === name) return refuse("you cannot send to yourself");
          // Who may be reached is decided by the RULES, not by this function: the same
          // question the operator answers once on the machine, asked for every message.
          // Hard-coding it here is how "agents may only reach their own crew" became a
          // fact of the code that no rule could change.
          // Look for the recipient HERE first, then in any project a rule names — a
          // recipient the code cannot find is a recipient no rule can ever permit, which
          // is how "cross-project messaging" stayed impossible while a setting claimed
          // otherwise.
          const sources = loadRules(cwd);
          let target = qualifier ? undefined : readRoster(cwd).find((e) => e.kind !== "main" && e.name === bareTo);
          let targetProject = cwd;
          if (!target) {
            const candidates = qualifier ? [resolvePath(qualifier)] : reachableProjects(cwd, sources).filter((p) => p !== cwd);
            for (const proj of candidates) {
              const hit = readRoster(proj).find((e) => e.kind !== "main" && e.name === bareTo);
              if (hit) { target = hit; targetProject = proj; break; }
            }
          }
          if (!target) {
            return refuse(
              `there is no agent called "${bareTo}"${qualifier ? ` in ${qualifier}` : " here, nor in any project a rule lets you reach"}. ` +
                `Ask the crew tool who is here; an agent elsewhere is addressed as name@/path/to/project and needs a rule naming that project.`,
            );
          }
          const attempt: TalkAttempt = {
            from: "peer", fromName: name, fromProject: cwd,
            to: "peer", toName: bareTo, toProject: target.project ?? targetProject,
          };
          // Judged HERE because a message leaving for another project is never seen by
          // this session's ask(), which only knows its own agents.
          const verdict = judge(attempt, sources);
          appendEvent(cwd, "talk.judged", {
            from: name, to: bareTo, project: targetProject, direction: "peer->peer",
            allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null,
          });
          if (!verdict.allowed) return refuse(refusalText(attempt, verdict));
          appendEvent(cwd, "send.sent", { from: name, to: bareTo, project: targetProject, chars: message.length });
          // An agent in ANOTHER project belongs to another session's manager, which this
          // process cannot call. It is reached the way anything crosses a project here:
          // through that project's control channel, which its live session applies.
          const out =
            resolvePath(targetProject) === resolvePath(cwd)
              ? await this.ask(bareTo, message, `peer:${name}`)
              : await deliverAcrossProjects(targetProject, bareTo, message, `peer:${name}@${cwd}`);
          appendEvent(cwd, "send.delivered", { from: name, to: bareTo, project: targetProject, status: out.status, replyChars: (out.reply ?? "").length });
          const text = out.status === "ok"
            ? `${to} replied: ${out.reply ?? "(nothing)"}`
            : out.status === "busy"
              ? `${to} is working right now — try again shortly.`
              : `${to} is no longer running.`;
          return { content: [{ type: "text", text }] };
        },
      },
    );
    // Every MUTATION passes through the project's write lock, so two agents in the
    // same shared worktree (even in two different pi processes) cannot interleave
    // their edits. Human ruling: no separate checkouts by default — one writer
    // waits, both edits survive.
    const MUTATING = new Set(["edit", "write", "bash"]);
    const lockCwd = cwd;
    for (const tool of readOnly) {
      if (!MUTATING.has(tool.name)) continue;
      const inner = tool.execute.bind(tool);
      tool.execute = async (...args: any[]) => {
        const { result, waitedMs, stole } = await withWriteLock(lockCwd, `${name}:${tool.name}`, () => inner(...args), {
          onWait: (_ms, current) => {
            appendEvent(lockCwd, "write-lock.waiting", { peer: name, tool: tool.name, heldBy: current?.holder, heldByPid: current?.pid });
            this.peers.get(name)?.pane.push({ kind: "note", text: `waiting for the write lock — ${current?.holder ?? "another agent"} is writing` });
            this.notify();
          },
        });
        if (waitedMs > 250) appendEvent(lockCwd, "write-lock.waited", { peer: name, tool: tool.name, waitedMs });
        if (stole) appendEvent(lockCwd, "write-lock.stale-taken", { peer: name, tool: tool.name, previousHolder: stole.holder, previousPid: stole.pid });
        appendEvent(lockCwd, "write-lock.done", { peer: name, tool: tool.name, waitedMs });
        return result;
      };
    }
    // tools: NAME ALLOWLIST — activates exactly the role's read-only set.
    // (noTools:"all" emptied the allowlist and left customTools registered
    // but INERT — peers were tool-less since v1; a live regression probe caught
    // the model imitating tool calls as text. Gate over faith.)
    const { session } = await mod.createAgentSession({
      cwd: toolsCwd,
      sessionManager: sm,
      model,
      modelRegistry: (ctx as any).modelRegistry,
      ...(this.peerModelRuntime ? { modelRuntime: this.peerModelRuntime } : {}),
      thinkingLevel: role.thinking ?? "low",
      tools: readOnly.map((t: any) => t.name),
      customTools: readOnly,
      resourceLoader,
    });
    return { session, model };
  }

  /** Session teardown that PRESERVES the crew in roster.json as 'suspended'
   *  — peers are part of the session and come back on recover(). */
  async suspendAll(): Promise<void> {
    const cwd = this.ctx?.cwd ?? process.cwd();
    // Every agent on record — including ended goals — stays in the census.
    const entries: RosterEntry[] = [...this.peers.values()].map((p) => ({
      name: p.name,
      role: p.role.name,
      address: p.address,
      peerSessionId: p.sessionId,
      peerSessionFile: p.sessionFile,
      parentSessionId: this.parentSessionId(),
      task: p.task,
      contextMode: p.contextMode,
      model: p.modelLabel,
      authority: p.role.authority ?? "read-only",
      ...(p.role.file ? { roleFile: p.role.file } : {}),
      ...(p.fileTerms ? { roleTerms: p.fileTerms } : {}),
      tickBaseS: p.role.tick,
      // A finished goal stays finished, and a STOPPED peer stays stopped:
      // only agents that were still working are 'suspended' (they resume).
      // Overwriting 'stopped' here made every stopped peer come back to life on
      // the next start -- recover() excludes stopped, but it never saw it.
      // Stopped peers deliberately REMAIN in this.peers: the census and the
      // panel's history depend on them.
      status: (p.status === "done" || p.status === "exhausted" || p.status === "stopped"
        ? p.status
        : "suspended") as PeerStatus,
      startedAt: p.startedAt,
      usage: { input: p.usage.input, output: p.usage.output, costUsd: Number(p.usage.costUsd.toFixed(6)) },
      mode: p.mode,
      cycles: p.cycles,
      ...(p.handoff ? { handoffSummary: p.handoff.summary } : {}),
      ...(p.gate ? { gate: p.gate, gatePassed: !!p.gatePassed, gateAttempts: p.gateAttempts ?? 0 } : {}),
      ...(p.wave ? { wave: p.wave.id, waveKey: p.wave.key } : {}),
      ...(p.objective ? { objective: p.objective } : {}),
      ...(p.watchCwd ? { watchCwd: p.watchCwd } : {}),
    }));
    if (entries.length > 0) this.mergeRoster(cwd, entries);
    for (const p of [...this.peers.values()]) {
      if (p.status === "stopped") continue;
      p.status = "stopped";
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      try {
        p.unsub?.();
        p.session.dispose?.();
      } catch {
        /* best-effort */
      }
      appendEvent(cwd, "peer.suspended", { peer: p.name, ticks: p.tickCount, findings: p.findings.length });
    }
    this.peers.clear();
  }

  /** Adopt an ORPHANED agent — one whose own session is gone — into this session's
   *  crew. Deliberately built on the recovery path rather than beside it: hand the
   *  entry over by rewriting its parent, then run the ordinary recovery, so an
   *  adopted agent is indistinguishable from a recovered one afterwards. */
  async attach(ctx: ExtensionContext, name: string): Promise<{ ok: boolean; message: string }> {
    this.setCtx(ctx);
    const cwd = ctx.cwd;
    const { readRoster, isOrphaned } = await import("./state.js");
    const myId = this.parentSessionId();
    const roster = readRoster(cwd) as RosterEntry[];
    const entry = roster.find((e) => e.name === name && e.kind !== "main");
    const refuse = (reason: string, detail: string) => {
      appendEvent(cwd, "peer.attach-refused", { peer: name, session: myId, reason });
      return { ok: false, message: detail };
    };
    if (!entry) return refuse("unknown", `no agent called "${name}" in this project — run \`pi-peer census\` to see who is here`);
    if (this.peers.has(name)) return refuse("already-mine", `${name} is already part of this session's crew`);
    if (["stopped", "done", "exhausted", "retired"].includes(entry.status)) {
      return refuse("ended", `${name} has finished (${entry.status}) — a finished agent is never revived. Launch a new one, or resume its session read-only to read what it did.`);
    }
    const { resolve: resolvePath } = await import("node:path");
    if (entry.project && resolvePath(entry.project) !== resolvePath(cwd)) {
      return refuse(
        "other-project",
        `${name} belongs to another project (${entry.project}) — agents are adopted inside their own project. Open a session there and adopt it, or move the work here deliberately.`,
      );
    }
    if (!isOrphaned(entry, roster)) {
      return refuse("live-owner", `${name} is being ticked by another live session — only an agent whose session is gone can be adopted. Stop it there first, or reach it with \`pi-peer ask\`.`);
    }
    const from = entry.parentSessionId;
    // Its ADDRESS moves with it. An adopted agent that keeps its old address signs
    // every finding with the session that died — the operator sees a report from a
    // session that no longer exists (found by an arc-close audit, 2026-08-08).
    const newAddress = `agent://pi/${myId}/${name}`;
    mutateRoster(cwd, (entries) =>
      entries.map((e) => (e.name === name && e.kind !== "main" ? { ...e, parentSessionId: myId, address: newAddress } : e)),
    );
    const before = this.peers.size;
    await this.recover(ctx);
    if (!this.peers.has(name)) {
      // Hand it back: a failed adoption must not leave the agent claimed by a session
      // that is not ticking it.
      mutateRoster(cwd, (entries) =>
        entries.map((e) => (e.name === name && e.kind !== "main" ? { ...e, parentSessionId: from, address: entry.address } : e)),
      );
      return refuse("revive-failed", `${name} could not be revived — see .pi/peer-agent/events.jsonl for peer.recover-failed`);
    }
    const peerNow = this.peers.get(name)!;
    peerNow.address = newAddress;
    // Telling an adopted agent who it now belongs to is a message from this session to it,
    // so it passes the same rule as any other. A session that may not address its agents
    // may not adopt one either.
    {
      const attempt: TalkAttempt = { from: "parent", fromName: "operator", fromProject: cwd, to: "peer", toName: name, toProject: cwd };
      const verdict = judge(attempt, loadRules(cwd));
      appendEvent(cwd, "talk.judged", { from: "operator", to: name, direction: "parent->peer", via: "adoption", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
      if (!verdict.allowed) return refuse("refused-by-rule", refusalText(attempt, verdict));
    }
    peerNow.pendingReceipts.push(
      `You have been ADOPTED. The session that launched you is gone; you now belong to session ${myId}. ` +
        `Your address is ${newAddress} — use it, and report to this session from now on. Everything else about you is unchanged.`,
    );
    peerNow.pane.push({ kind: "note", text: `adopted by session ${shortId(myId)} — reporting here now` });
    appendEvent(cwd, "peer.attached", { peer: name, fromSession: from, toSession: myId, fromAddress: entry.address, toAddress: newAddress, crewSize: this.peers.size, wasCrewSize: before });
    this.refreshRoster(cwd);
    this.notify();
    const peer = this.peers.get(name)!;
    return { ok: true, message: `${name} adopted — ${peer.mode === "task" ? "task" : `ticking ${rhythmOf(peer)}`} in this session now, memory intact` };
  }

  /** Revive this session's suspended crew from roster.json — each peer
   *  resumes its OWN session file with full memory. */
  async recover(ctx: ExtensionContext): Promise<number> {
    this.setCtx(ctx);
    const cwd = ctx.cwd;
    const { readRoster } = await import("./state.js");
    const { adhocRole, discoverRoles } = await import("./roles.js");
    const { existsSync } = await import("node:fs");
    const parentId = this.parentSessionId();
    // RESUME: pi gives a resumed session a NEW id while keeping the same session
    // FILE (measured 2026-08-07). Matching on id alone therefore disowned the whole
    // crew on the very restart an operator expects to be seamless — the peers were
    // still on disk and showed as orphaned. Any earlier main entry that used THIS
    // session file is the same conversation, so its peers are ours.
    const roster = readRoster(cwd);
    const myFile = (ctx as any)?.sessionManager?.getSessionFile?.() ?? this.parentSessionFile();
    const myPriorIds = new Set(
      roster.filter((e) => e.kind === "main" && myFile && e.peerSessionFile === myFile).map((e) => e.peerSessionId),
    );
    myPriorIds.add(parentId);
    const entries = roster.filter(
      (e) =>
        myPriorIds.has(e.parentSessionId) &&
        // Ended agents stay in the census but are not revived: a finished
        // goal must not start ticking again on session resume.
        !["stopped", "done", "exhausted"].includes(e.status) &&
        !this.peers.has(e.name),
    );
    if (entries.length === 0) {
      // Say what was looked for: a resume that adopts nothing used to look identical
      // to a session that never had a crew.
      appendEvent(cwd, "crew.recover-empty", { session: parentId, sessionFile: myFile ? String(myFile).split("/").pop() : null, priorSessions: [...myPriorIds], candidates: roster.filter((e) => e.kind !== "main").map((e) => `${e.name}:${e.status}:${String(e.parentSessionId).slice(0, 8)}`) });
      return 0;
    }
    if (myPriorIds.size > 1) {
      appendEvent(cwd, "crew.readopted", { session: parentId, priorSessions: [...myPriorIds].filter((id) => id !== parentId), peers: entries.map((e) => e.name) });
    }
    const mod: any = await import("@earendil-works/pi-coding-agent");
    const roles = discoverRoles(cwd);
    let recovered = 0;
    for (const entry of entries) {
      try {
        if (!existsSync(entry.peerSessionFile)) {
          appendEvent(cwd, "peer.recover-failed", { peer: entry.name, reason: "session file missing" });
          continue;
        }
        // An on-the-fly role has no file to rediscover -- it was synthesised
        // from the launch instruction. Rebuild it from the task the roster
        // already stores, or the agent can NEVER be revived: it suspends on
        // shutdown and is skipped on every recovery, silently, forever.
        // (Operator: "why has the agent in this session suspended? that is
        // exactly what it should not have to be" -- their stranded agent was
        // an adhoc one.)
        // An agent MUST come back with its session. Not "usually" -- always.
        // A role file can be missing for reasons that have nothing to do with
        // the agent: an on-the-fly role was synthesised and never had a file, a
        // role file was renamed or deleted, a project-scoped role is gone
        // because the agent watches a different directory. Previously any of
        // those stranded the agent permanently: suspended on shutdown, skipped
        // on every recovery, silently. The roster already stores everything
        // needed to rebuild a working role from the agent's own task, so that
        // is the fallback, and it is ledgered rather than hidden.
        const filedRole = roles.find((r) => r.name === entry.role);
        // Only an on-the-fly role legitimately has no file. Anything else means
        // a role file that existed at launch is gone now -- renamed, deleted,
        // or out of scope. The agent still comes back (it must: an agent that
        // suspends with its session has to return with it), but it comes back
        // as ITSELF: the original role name is preserved rather than relabelled
        // 'adhoc', which would quietly rewrite the record. And the anomaly is
        // raised, not swallowed -- a missing role file is a real problem to
        // look at, even though it is not a reason to lose the agent.
        const expected = entry.role === "adhoc";
        const baseRole = filedRole ?? {
          ...adhocRole(entry.task),
          name: entry.role,
          source: expected ? "on-the-fly" : "rebuilt — role file missing",
        };
        if (!filedRole) {
          appendEvent(cwd, expected ? "peer.role-synthesised" : "peer.role-missing", {
            peer: entry.name,
            role: entry.role,
            detail: expected
              ? "on-the-fly role, no file by design"
              : "role file was present at launch and is absent now; agent recovered from its stored task with its identity intact",
          });
          if (!expected) {
            try {
              (ctx as any).ui?.notify?.(
                `role file for "${entry.role}" is missing — ${entry.name} recovered from its stored task. Restore peers/${entry.role}.md to keep its charter.`,
                "warning",
              );
            } catch {
              /* advisory */
            }
          }
        }
        // The role file may have changed while this agent was away. Applying the new
        // terms silently would rewrite what the agent is, mid-life; refusing them would
        // strand it on a contract nobody can read. So: apply, and SAY SO — naming each
        // term that moved, in the ledger and in the agent's own pane.
        if (entry.roleTerms && filedRole) {
          const now = { ...(filedRole.kind ? { kind: filedRole.kind } : {}), authority: filedRole.authority ?? "read-only", tick: filedRole.tick, priorityCeiling: filedRole.priorityCeiling, context: filedRole.context } as Record<string, unknown>;
          const was = entry.roleTerms as unknown as Record<string, unknown>;
          const moved = Object.keys(now).filter((k) => String(now[k]) !== String(was[k]));
          if (moved.length) {
            appendEvent(cwd, "peer.contract-changed", { peer: entry.name, role: entry.role, file: entry.roleFile ?? filedRole.file, changed: moved.map((k) => `${k}: ${was[k]} → ${now[k]}`) });
            // Adopt the file as the new baseline HERE, not by hoping a later roster write
            // carries it: reporting the same edit on every future recovery is a false
            // alarm, and relying on the refresh path made it timing-dependent.
            mutateRoster(cwd, (all) => all.map((x) => (x.name === entry.name && x.kind !== "main" ? { ...x, roleTerms: now as RosterEntry["roleTerms"] } : x)));
            try {
              (ctx as any).ui?.notify?.(`${entry.name}: its role file changed while it was away — ${moved.map((k) => `${k} ${was[k]} → ${now[k]}`).join(", ")}`, "warning");
            } catch {
              /* advisory */
            }
          }
        }
        const role: PeerRole = {
          ...baseRole,
          tick: entry.tickBaseS || baseRole.tick,
          // Authority survives a restart: an agent the human elevated must not
          // silently drop back to read-only on recovery, nor keep authority it
          // no longer has. The roster is the record.
          authority: entry.authority ?? baseRole.authority ?? "read-only",
          tools: AUTHORITY_TOOLS[entry.authority ?? baseRole.authority ?? "read-only"],
        };
        const sm = mod.SessionManager.open(entry.peerSessionFile, undefined, cwd);
        const { session, model } = await this.assemblePeerSession(
          ctx, cwd, role, entry.name, entry.address, parentId, sm,
          entry.model && entry.model !== "default" ? entry.model : undefined,
          entry.watchCwd,
        );
        const peer: Peer = {
          name: entry.name, role, task: entry.task, contextMode: entry.contextMode,
          modelLabel: model ? `${model.provider}/${model.id}` : entry.model,
          address: entry.address, session,
          sessionId: sm.getSessionId?.() ?? entry.peerSessionId,
          sessionFile: entry.peerSessionFile,
          status: "waiting", tickCount: 0, quietStreak: 0, backoffIdx: 0,
          nextTickAt: Date.now(), timer: null, busy: false,
          watermark: ((ctx as any).sessionManager?.getEntries?.() ?? []).length,
          pane: [], findings: [], pendingRetask: null, pendingReceipts: [], unsub: null,
          // The recovered agent must carry the file's terms too, or the next roster write
          // drops them and the contract comparison can never fire again — a check that
          // cannot fail (found by an arc-close audit reading the recovery path).
          fileTerms: filedRole
            ? { ...(filedRole.kind ? { kind: filedRole.kind } : {}), authority: filedRole.authority ?? "read-only", tick: filedRole.tick, priorityCeiling: filedRole.priorityCeiling, context: filedRole.context }
            : entry.roleTerms,
          startedAt: entry.startedAt,
          usage: entry.usage ? { ...entry.usage } : { input: 0, output: 0, costUsd: 0 },
          mode: entry.mode ?? "watch",
          cycles: entry.cycles ?? 0,
          ...(entry.objective ? { objective: entry.objective } : {}),
          ...(entry.watchCwd ? { watchCwd: entry.watchCwd } : {}),
        };
        // Callsign counter continuity (sentinel-2 must not collide).
        const suffix = Number.parseInt(entry.name.split("-").pop() ?? "", 10);
        const base = entry.name.replace(/-\d+$/, "");
        if (Number.isFinite(suffix)) this.counters.set(base, Math.max(this.counters.get(base) ?? 0, suffix));
        peer.pane.push({ kind: "note", text: `recovered with session — ${peer.mode === "task" ? "task resumed" : "watch continues"} (${entry.contextMode}, ${rhythmOf(peer)})` });
        this.attachStream(peer);
        this.peers.set(entry.name, peer);
        this.scheduleTick(peer, 3000);
        appendEvent(cwd, "peer.recovered", { peer: entry.name, peerSessionId: peer.sessionId });
        recovered++;
      } catch (err) {
        appendEvent(cwd, "peer.recover-failed", { peer: entry.name, reason: String(err).slice(0, 200) });
      }
    }
    if (recovered > 0) {
      this.refreshRoster(cwd);
      this.notify();
    }
    return recovered;
  }

  private parentSessionId(): string {
    try {
      return (this.ctx as any)?.sessionManager?.getSessionId?.() ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private parentSessionFile(): string | undefined {
    try {
      return (this.ctx as any)?.sessionManager?.getSessionFile?.() ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Write MY agents while preserving every agent owned by another session in
   *  this project. Two pi sessions in one directory used to overwrite each
   *  other's roster wholesale, making agents vanish from the census. */
  private mergeRoster(cwd: string, mine: RosterEntry[]): void {
    const myId = this.parentSessionId();
    // A resumed session carries a new id but the same peers. Drop the entries of
    // any PRIOR session that used this same session file as well as my own, or the
    // crew is listed twice — once alive under the new id, once orphaned under the
    // old (seen in a panel-memory drill).
    const myFile = (this.ctx as any)?.sessionManager?.getSessionFile?.();
    mutateRoster(cwd, (entries) => {
      const priorIds = new Set(
        entries.filter((e) => e.kind === "main" && myFile && e.peerSessionFile === myFile).map((e) => e.peerSessionId),
      );
      priorIds.add(myId);
      const mineNames = new Set(mine.map((m) => m.name));
      // Keep a prior session's peers on the roster: recovery reads them from here
      // moments later, and an earlier version of this filter deleted the crew
      // before it could be adopted. Only replace what I am rewriting, plus the
      // stale main entries for this same session file.
      return [
        ...entries.filter(
          (e) =>
            e.parentSessionId !== myId &&
            !mineNames.has(e.name) &&
            !(e.kind === "main" && e.peerSessionId !== myId && priorIds.has(e.peerSessionId)),
        ),
        ...mine,
      ];
    });
  }

  /** Callsigns are unique across the whole PROJECT, not just this session —
   *  a second session must not mint a colliding name. */
  private callsign(role: PeerRole): string {
    // The full role name, not its last segment: `builder-once` and `reviewer-once`
    // both ended up as `once-N`, a callsign that named neither job.
    const base = role.name;
    const taken = new Set<string>([...this.peers.keys()]);
    try {
      for (const e of readRoster(this.ctx?.cwd ?? process.cwd()) as RosterEntry[]) taken.add(e.name);
    } catch {
      /* roster unreadable — session-local uniqueness still holds */
    }
    let n = (this.counters.get(base) ?? 0) + 1;
    while (taken.has(`${base}-${n}`)) n++;
    this.counters.set(base, n);
    return `${base}-${n}`;
  }

  /** Compacted context brief: latest compaction summary if present, else a trimmed transcript tail. */
  private contextBrief(): string {
    try {
      const entries: any[] = (this.ctx as any)?.sessionManager?.getEntries?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === "compaction" && typeof entries[i].summary === "string") {
          return `Parent session summary (from its own compaction):\n${entries[i].summary.slice(0, 6000)}`;
        }
      }
      const tail = serializeDelta(entries, Math.max(0, entries.length - 40), 4000);
      return tail ? `Recent parent conversation (trimmed):\n${tail}` : "";
    } catch {
      return "";
    }
  }

  /** Launch several tasks as ONE wave: same role and grant, distinct keys and jobs.
   *  Members run concurrently (their mutations still serialize on the write lock);
   *  the main agent hears once, when the last member retires. */
  async launchWave(
    ctx: ExtensionContext, role: PeerRole, items: { key: string; task: string }[],
    opts: { mode?: ContextMode; watchCwd?: string; gate?: string } = {},
  ): Promise<{ waveId: string; peers: Peer[] }> {
    const waveId = uid();
    const peers: Peer[] = [];
    appendEvent(ctx.cwd, "wave.launched", { wave: waveId, size: items.length, keys: items.map((i) => i.key), role: role.name, ...(opts.gate ? { gate: opts.gate } : {}) });
    for (const item of items) {
      const peer = await this.launch(ctx, role, item.task, opts.mode, undefined, opts.watchCwd, undefined, "task", opts.gate, { id: waveId, key: item.key });
      peers.push(peer);
    }
    return { waveId, peers };
  }

  async launch(ctx: ExtensionContext, role: PeerRole, task: string, mode?: ContextMode, modelRef?: string, watchCwd?: string, objective?: Objective, kind?: AgentMode, gate?: string, wave?: { id: string; key: string }): Promise<Peer> {
    this.ctx = ctx;
    const cwd = ctx.cwd;
    if (watchCwd) {
      const fsm = await import("node:fs");
      if (!fsm.existsSync(watchCwd)) throw new Error(`watch directory does not exist: ${watchCwd}`);
    }
    if (this.active.length >= this.config.maxPeers) {
      ctx.ui?.notify?.(`peer cap (${this.config.maxPeers}) reached — launching anyway (soft cap)`, "warning");
    }
    const contextMode: ContextMode = mode ?? role.context;
    const name = this.callsign(role);
    const parentId = this.parentSessionId();
    const address = `agent://pi/${parentId}/${name}`;

    // P7: write-intent BEFORE the session exists.
    appendEvent(cwd, "peer.spawned", {
      peer: name, role: role.name, address, parentSessionId: parentId,
      ...(role.file ? { roleFile: role.file } : {}),
      roleTerms: { ...(role.kind ? { kind: role.kind } : {}), authority: role.authority ?? "read-only", tick: role.tick, priorityCeiling: role.priorityCeiling, context: role.context },
      contextMode, task, model: modelRef ?? role.model ?? "parent", tickBaseS: role.tick,
      ...(kind === "task"
        ? { mode: "task", ...(gate ? { gate } : {}), ...(wave ? { wave: wave.id, waveKey: wave.key } : {}) }
        : kind === "mission"
          ? { mode: "mission" }
          : objective
            ? { mode: "goal", objective }
            : role.kind === "task"
              ? { mode: "task", ...(gate ? { gate } : {}) }
              : role.kind === "mission"
                ? { mode: "mission" }
                : role.kind === "goal"
                  ? { mode: "goal" }
                  : { mode: "watch" }),
      ...(watchCwd ? { watchCwd } : {}),
    });

    const mod: any = await import("@earendil-works/pi-coding-agent");
    const parentFile = this.parentSessionFile();
    // Peer sessions live in a subdirectory so they never pollute the main
    // session dir's recency — bare `pi --continue` must always resume the
    // OPERATOR's session, not a peer's. Resume-by-path is unaffected.
    const peerSessionDir = await this.peerSessionDir(cwd);
    const sm =
      contextMode === "fork" && parentFile
        ? mod.SessionManager.forkFrom(parentFile, cwd, peerSessionDir)
        : mod.SessionManager.create(cwd, peerSessionDir);
    const { session, model } = await this.assemblePeerSession(ctx, cwd, role, name, address, parentId, sm, modelRef ?? role.model, watchCwd);

    const peer: Peer = {
      name, role, task, contextMode,
      modelLabel: model ? `${model.provider}/${model.id}` : "default",
      address, session,
      usage: { input: 0, output: 0, costUsd: 0 },
      // Precedence: an explicit KIND flag, then an explicit OBJECTIVE (--until-file /
      // --until-exit0 is just as manual an instruction as --task), then the contract,
      // then the historical default. A drill caught the middle rung missing: a task
      // contract swallowed --until-file and the agent never worked in cycles.
      mode: kind === "task" ? "task" : kind === "mission" ? "mission" : objective ? "goal" : role.kind ?? "watch",
      ...(kind === "task" && gate ? { gate, gateAttempts: 0, gatePassed: false } : {}),
      ...(kind === "task" && wave ? { wave } : {}),
      ...(role.fallbackModels?.length ? { fallbackChain: [...role.fallbackModels] } : {}),
      cycles: 0,
      ...(objective ? { objective } : {}),
      ...(watchCwd ? { watchCwd } : {}),
      sessionId: sm.getSessionId?.() ?? "unknown",
      sessionFile: sm.getSessionFile?.() ?? "(in-memory)",
      status: "starting", tickCount: 0, quietStreak: 0, backoffIdx: 0,
      nextTickAt: Date.now(), timer: null, busy: false,
      watermark: ((ctx as any).sessionManager?.getEntries?.() ?? []).length,
      pane: [], findings: [], pendingRetask: null, pendingReceipts: [], unsub: null,
      fileTerms: { ...(role.kind ? { kind: role.kind } : {}), authority: role.authority ?? "read-only", tick: role.tick, priorityCeiling: role.priorityCeiling, context: role.context },
      startedAt: new Date().toISOString(),
    };
    // In fork mode the peer has the full lineage; watch from now. In other
    // modes the context brief covers history, so also watch from now.
    this.attachStream(peer);
    this.peers.set(name, peer);
    upsertAgentsBlock(cwd);
    this.refreshRoster(cwd);
    appendEvent(cwd, "peer.session", { peer: name, peerSessionId: peer.sessionId, peerSessionFile: peer.sessionFile });

    // No transcript entry on launch — appending one auto-scrolls the main
    // transcript (operator complaint). The toast, panel, roster.json and
    // AGENTS block carry the awareness; findings arrive attributed anyway.
    // A TASK is not ticked: it runs its single engagement now and
    // retires. Everything else keeps the interval loop.
    // A TASK runs once, now — whether the kind came from a flag or from the role's
    // own contract. A MISSION and a WATCH are woken by the clock.
    if (peer.mode === "task") void this.runTask(peer, cwd);
    else this.scheduleTick(peer, 100); // first tick almost immediately
    this.notify();
    return peer;
  }

  /** The TASK lifecycle: one continuous engagement → handoff → retire.
   *  No tick loop, no cycles, no standing objective. The handoff is the
   *  deliverable, so a task that ends without one is asked once, and its
   *  absence is recorded rather than hidden. */
  private async runTask(peer: Peer, cwd: string): Promise<void> {
    peer.busy = true;
    peer.status = "thinking";
    appendEvent(cwd, "task.started", { peer: peer.name, task: peer.task, model: peer.modelLabel });
    peer.pane.push({ kind: "tick", text: "— task —" });
    this.notify();
    const usageFrom = (peer.session.state?.messages ?? []).length;
    const contract =
      `YOUR JOB: ${peer.task}\n\n` +
      `You are a TASK agent: one engagement, start to finish. You are NOT ticked, ` +
      `you have no standing objective, and nothing will wake you again — so do the ` +
      `whole job now, using your tools, in this working directory.\n\n` +
      `When the job is done, end your reply with a handoff block in exactly this shape:\n\n` +
      `HANDOFF\nsummary: <what you did, in one or two sentences>\n` +
      `changed files: <paths, or none>\ncommands: <commands you ran with their exit codes, or none>\n` +
      `evidence: <what proves it works, or none>\nsurprises: <anything unexpected, or none>\n` +
      `decisions: <anything you refused to decide alone and the operator must rule, or none>\n\n` +
      `Do not stop before the job is done, and do not invent work nobody asked for.` +
      (peer.gate
        ? `\n\nACCEPTANCE GATE: \`${peer.gate}\`. The FRAMEWORK runs this command after you hand off — you cannot finish by saying you are finished. If it does not exit 0 you get its output back and keep working.\n` +
          `The gate CHECKS the job; it is not the job. Do the work the job describes and let the check confirm it. Satisfying the command by other means (creating what it looks for without doing the work, editing the check, or weakening it) is a failure and will be reported as one.`
        : "");
    try {
      await this.promptPeer(peer, contract, cwd);
      let text = this.lastAssistantText(peer);
      // Same work-before-report discipline as ticks, with a task-sized budget:
      // keep going while it is genuinely using tools and has not handed off.
      let turns = 0;
      while (!parseHandoff(text) && turns < TASK_TURN_BUDGET && this.usedToolsLastTurn(peer)) {
        turns++;
        appendEvent(cwd, "task.work-turn", { peer: peer.name, turn: turns });
        await this.promptPeer(peer, "Continue with your tools until the job is done, then end with the HANDOFF block.", cwd);
        text = this.lastAssistantText(peer);
      }
      if (!parseHandoff(text)) {
        appendEvent(cwd, "task.handoff-reask", { peer: peer.name, afterWorkTurns: turns });
        await this.promptPeer(peer, "Reply NOW with only the HANDOFF block (summary, changed files, commands, evidence, surprises, decisions).", cwd);
        text = this.lastAssistantText(peer);
      }
      let handoff = parseHandoff(text);
      // ACCEPTANCE GATE: the framework runs the command itself. A task
      // that claims completion while its gate fails is handed the failure and keeps
      // working; it cannot retire on its own word.
      if (peer.gate) {
        for (let attempt = 1; attempt <= TASK_GATE_ATTEMPTS; attempt++) {
          const g = runGate(peer.gate, peer.watchCwd ?? cwd);
          peer.gateAttempts = attempt;
          if (g.passed) {
            peer.gatePassed = true;
            appendEvent(cwd, "task.gate-passed", { peer: peer.name, gate: peer.gate, attempt });
            peer.pane.push({ kind: "note", text: `✓ acceptance check passed: ${peer.gate}` });
            break;
          }
          appendEvent(cwd, "task.gate-failed", { peer: peer.name, gate: peer.gate, attempt, exitCode: g.exitCode, output: g.output.slice(0, 1000) });
          peer.pane.push({ kind: "note", text: `the acceptance check failed (attempt ${attempt}/${TASK_GATE_ATTEMPTS}) — the task keeps working` });
          this.notify();
          if (attempt === TASK_GATE_ATTEMPTS) break;
          await this.promptPeer(peer,
            `Your work does NOT pass its acceptance gate yet. The framework ran \`${peer.gate}\` and it exited ${g.exitCode}:\n\n${g.output.slice(0, 2000)}\n\nFix the cause and hand off again with an updated HANDOFF block.`, cwd);
          text = this.lastAssistantText(peer);
          handoff = parseHandoff(text) ?? handoff;
        }
      }
      if (handoff) {
        peer.handoff = handoff;
        appendEvent(cwd, "task.handoff", {
          peer: peer.name, summary: handoff.summary,
          changedFiles: handoff.changedFiles, commands: handoff.commands,
          evidence: handoff.evidence, surprises: handoff.surprises, decisions: handoff.decisions,
        });
      } else {
        appendEvent(cwd, "task.handoff-missing", { peer: peer.name, lastText: text.slice(0, 500) });
        peer.pane.push({ kind: "note", text: "the task ended without a handoff — its last words are above" });
      }
      this.retireTask(peer, cwd);
    } catch (err) {
      peer.status = "error";
      appendEvent(cwd, "task.error", { peer: peer.name, error: String(err).slice(0, 300) });
      peer.pane.push({ kind: "note", text: `the task failed: ${String(err).slice(0, 120)}` });
      this.refreshRoster(cwd);
    } finally {
      this.accountUsage(peer, usageFrom, "tick", cwd);
      peer.busy = false;
      this.notify();
    }
  }

  /** A retired task stops for good but keeps its session (resumable) and its
   *  handoff, and its completion travels the ordinary finding path so the main
   *  agent hears about it exactly once. */
  private retireTask(peer: Peer, cwd: string): void {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    peer.status = "retired";
    const gateOk = !peer.gate || peer.gatePassed === true;
    appendEvent(cwd, "task.retired", { peer: peer.name, hadHandoff: !!peer.handoff, ...(peer.gate ? { gate: peer.gate, gatePassed: !!peer.gatePassed, gateAttempts: peer.gateAttempts ?? 0 } : {}) });
    peer.pane.push({ kind: "note", text: gateOk ? `✓ task finished — handed off and retired` : `task ended WITHOUT passing its acceptance check (${peer.gate}) — nothing was accepted` });
    this.refreshRoster(cwd);
    this.notify();
    const h = peer.handoff;
    const gateLine = peer.gate ? (peer.gatePassed ? `acceptance check passed: ${peer.gate}` : `NOT ACCEPTED — the acceptance check never passed after ${peer.gateAttempts ?? 0} attempt(s): ${peer.gate}`) : "";
    const body0 = h
      ? [
          h.summary,
          h.changedFiles.length ? `changed: ${h.changedFiles.join(", ")}` : "",
          h.commands.length ? `ran: ${h.commands.join(", ")}` : "",
          h.evidence.length ? `evidence: ${h.evidence.join(", ")}` : "",
          h.surprises.length ? `surprises: ${h.surprises.join(", ")}` : "",
          h.decisions.length ? `NEEDS YOU: ${h.decisions.join(", ")}` : "",
        ].filter(Boolean).join("\n")
      : `the task ended without a handoff. Last words:\n${this.lastAssistantText(peer).slice(0, 800)}`;
    const body = gateLine ? `${gateLine}\n${body0}` : body0;
    // A task that needs a ruling steers; a clean finish waits for the next
    // natural boundary. Same delivery contract as any finding.
    const finding: Finding = {
      id: uid(), peer: peer.name, tick: 0, ts: Date.now(), clamped: false,
      // A task that failed its gate is never quiet news.
      priority: peer.gate && !peer.gatePassed ? "steering" : h?.decisions.length ? "steering" : "info",
      body, ...(h?.changedFiles.length ? { refs: h.changedFiles } : {}),
    };
    peer.findings.push(finding);
    // A WAVE speaks once. Members keep their own findings (visible in the panel and
    // the ledger), but the main agent is told when the LAST member retires — five
    // tasks are one interruption, not five.
    if (peer.wave) {
      const members = [...this.peers.values()].filter((p) => p.wave?.id === peer.wave!.id);
      const pending = members.filter((p) => p.status !== "retired" && p.status !== "error");
      appendEvent(cwd, "wave.member-retired", { wave: peer.wave.id, key: peer.wave.key, peer: peer.name, remaining: pending.length });
      if (pending.length === 0) this.deliverWave(peer.wave.id, members, cwd);
      return;
    }
    this.deliver(peer, finding, cwd);
  }

  private attachStream(peer: Peer): void {
    const push = (entry: PaneEntry) => {
      peer.pane.push(entry);
      if (peer.pane.length > PANE_CAP) peer.pane.splice(0, peer.pane.length - PANE_CAP);
      this.notify();
    };
    peer.unsub = peer.session.subscribe((ev: any) => {
      try {
        // A provider error must never look like a quiet agent. pi records an
        // errored turn as an assistant message with EMPTY content, which the
        // verdict/handoff parsers then read as "said nothing" — the exact
        // silent-failure this product forbids. Both the retry notice (which
        // carries the provider's text) and the errored turn are ledgered and
        // shown in the pane (found while proving the TASK kind, 2026-08-06).
        if (ev?.type === "auto_retry_start") {
          appendEvent(this.ctx?.cwd ?? process.cwd(), "peer.provider-error", { peer: peer.name, attempt: ev.attempt, maxAttempts: ev.maxAttempts, error: String(ev.errorMessage ?? "").slice(0, 500) });
          push({ kind: "note", text: `the model provider refused this turn (retry ${ev.attempt}/${ev.maxAttempts}): ${String(ev.errorMessage ?? "").slice(0, 200)}` });
        } else if (ev?.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") {
          peer.status = "error";
          appendEvent(this.ctx?.cwd ?? process.cwd(), "peer.turn-failed", { peer: peer.name, error: String(ev.message?.errorMessage ?? ev.errorMessage ?? "provider returned an error with no message").slice(0, 500) });
          push({ kind: "note", text: `this turn failed at the model provider — nothing was produced${ev.message?.errorMessage ? `: ${String(ev.message.errorMessage).slice(0, 200)}` : ""}` });
        }
        if (ev?.type === "message_start" && ev.message?.role === "assistant") {
          peer.status = "thinking";
          push({ kind: "text", text: "", streaming: true });
        } else if (ev?.type === "message_update" && ev.message?.role === "assistant") {
          const texts: string[] = [];
          const thinks: string[] = [];
          const tools: string[] = [];
          if (Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) {
              if (b?.type === "text" && b.text) texts.push(b.text);
              else if (b?.type === "thinking" && b.thinking) thinks.push(b.thinking);
              else if (b?.type === "toolCall") tools.push(b.name);
            }
          }
          // Rewrite the tail streaming entries in place.
          peer.pane = peer.pane.filter((p) => !p.streaming);
          if (thinks.length) peer.pane.push({ kind: "thinking", text: thinks.join("\n"), streaming: true });
          if (tools.length) peer.pane.push({ kind: "tool", text: tools.join(" · "), streaming: true });
          if (texts.length) peer.pane.push({ kind: "text", text: texts.join("\n"), streaming: true });
          if (peer.pane.length > PANE_CAP) peer.pane.splice(0, peer.pane.length - PANE_CAP);
          this.notify();
        } else if (ev?.type === "message_end") {
          for (const p of peer.pane) p.streaming = false;
          this.notify();
        }
      } catch {
        /* stream rendering is best-effort */
      }
    });
  }

  private scheduleTick(peer: Peer, delayMs: number): void {
    if (peer.timer) clearTimeout(peer.timer);
    peer.nextTickAt = Date.now() + delayMs;
    peer.timer = setTimeout(() => void this.runTick(peer), delayMs);
    this.notify();
  }

  private backoffDelayMs(peer: Peer): number {
    // Goals hold a steady cadence: their QUIET means "still working toward
    // the condition", not "nothing happened" — backing off would stretch a
    // bounded goal into an unbounded wait.
    if (peer.mode === "goal" || peer.mode === "mission") return peer.role.tick * 1000;
    const mult = this.config.backoff[Math.min(peer.backoffIdx, this.config.backoff.length - 1)] ?? 1;
    return peer.role.tick * 1000 * mult;
  }

  private async runTick(peer: Peer): Promise<void> {
    if (peer.status === "stopped") return;
    const ctx = this.ctx;
    if (!ctx || peer.busy) {
      this.scheduleTick(peer, 1500);
      return;
    }
    const cwd = ctx.cwd;
    const entries: any[] = (ctx as any).sessionManager?.getEntries?.() ?? [];
    const delta = serializeDelta(entries, peer.watermark, this.config.deltaCapChars);
    const retask = peer.pendingRetask;
    peer.pendingRetask = null;

    // Goals cycle against their CONDITION, not the conversation: the
    // delta gate (right for watches) would freeze a goal whenever the
    // main agent is quiet — exactly when a goal is most likely working.
    // A MISSION works its own charge, so "the main agent said nothing" is not a
    // reason to skip its tick — the same reasoning that exempts a goal.
    if (peer.mode !== "goal" && peer.mode !== "mission" && !delta && !retask && peer.tickCount > 0 && !peer.role.tickWithoutDelta) {
      peer.backoffIdx = Math.min(peer.backoffIdx + 1, this.config.backoff.length - 1);
      appendEvent(cwd, "tick.skipped", { peer: peer.name, tick: peer.tickCount, backoffIdx: peer.backoffIdx });
      peer.pane.push({ kind: "tick", text: "·" });
      this.scheduleTick(peer, this.backoffDelayMs(peer));
      return;
    }

    peer.watermark = entries.length;
    peer.tickCount++;
    peer.busy = true;
    peer.status = "thinking";
    appendEvent(cwd, "tick.issued", { peer: peer.name, tick: peer.tickCount, deltaChars: delta.length, retask: !!retask });
    peer.pane.push({ kind: "tick", text: `— tick ${peer.tickCount} —` });
    this.notify();

    const parts: string[] = [];
    if (peer.tickCount === 1) {
      parts.push(`TICK 1. YOUR ASSIGNED TASK: ${peer.task}`);
      if (peer.contextMode === "compacted") {
        const brief = this.contextBrief();
        if (brief) parts.push(brief);
      }
    } else {
      parts.push(`TICK ${peer.tickCount}. Task unchanged: ${peer.task}`);
    }
    if (peer.mode === "mission") {
      parts.push(
        `MISSION — tick ${peer.tickCount}. This is YOUR standing charge, not a watch over someone else's work: ` +
          `advance it with your tools this tick, then say in one short paragraph what you actually did and what is left. ` +
          `Nothing ends you but the operator — there is no completion condition to satisfy and no reason to invent one. ` +
          `If you are blocked or need a ruling, say so as a FINDING; otherwise end with QUIET.`,
      );
    }
    if (peer.mode === "goal" && peer.objective) {
      const cap = peer.objective.maxCycles ?? 20;
      parts.push(
        `GOAL MODE — cycle ${peer.cycles + 1} of at most ${cap}.\n` +
          `COMPLETION CONDITION (evaluated by the FRAMEWORK after every cycle, never by you): ` +
          (peer.objective.kind === "file" ? `the file ${peer.objective.value} exists.` : `the command \`${peer.objective.value}\` exits 0.`) +
          `\nWork toward it, report progress in one short paragraph, and end with QUIET (or a FINDING if something needs the main agent NOW). ` +
          `Claiming DONE does not end the goal — only the condition does.`,
      );
    }
    if (retask) parts.push(`RETASK from the main agent: ${retask}`);
    if (peer.pendingReceipts.length > 0) {
      parts.push(`DELIVERY RECEIPTS since your last tick:\n${peer.pendingReceipts.join("\n")}`);
      peer.pendingReceipts = [];
    }
    parts.push(delta ? `DELTA — what the main agent did since your last look:\n${delta}` : `No conversation delta this tick.`);
    parts.push(`End with your verdict line (QUIET or FINDING[…]: …).`);

    const usageFrom = (peer.session.state?.messages ?? []).length;
    try {
      await this.promptPeer(peer, parts.join("\n\n"), cwd);
      let text = this.lastAssistantText(peer);
      // WORK BEFORE VERDICT (incident 2026-08-05: a work-capable peer answered
      // "I'll start — let me look at the docs", the verdict re-ask consumed the
      // turn, and it did ZERO tool calls for 34 minutes). A peer that is still
      // working gets to continue up to a turn budget; the verdict is only
      // demanded once it stops using tools. Monitors are unaffected: they emit
      // a verdict on turn one and never enter the loop.
      const budget = peer.mode === "goal" || peer.mode === "mission" ? 6 : 3;
      let turns = 0;
      while (!this.parseVerdict(text) && turns < budget && this.usedToolsLastTurn(peer)) {
        turns++;
        appendEvent(cwd, "peer.work-turn", { peer: peer.name, tick: peer.tickCount, turn: turns });
        await this.promptPeer(peer, "Continue working with your tools. When you have nothing further to do this cycle, finish with your verdict line (QUIET or FINDING[...]: ...).", cwd);
        text = this.lastAssistantText(peer);
      }
      if (!this.parseVerdict(text)) {
        appendEvent(cwd, "peer.verdict-reask", { peer: peer.name, tick: peer.tickCount, afterWorkTurns: turns });
        await this.promptPeer(peer, "Your verdict line was missing. Reply NOW with only the verdict line: QUIET or FINDING[info|steering|interrupt]: <paragraph>.", cwd);
        text = this.lastAssistantText(peer);
      }
      this.handleVerdict(peer, text, cwd);
    } catch (err) {
      // API errors (429s, transient network) must not look like judgment:
      // status error, note, and a HARDER backoff than a quiet tick.
      peer.status = "error";
      peer.backoffIdx = this.config.backoff.length - 1;
      appendEvent(cwd, "peer.error", { peer: peer.name, tick: peer.tickCount, error: String(err).slice(0, 300) });
      peer.pane.push({ kind: "note", text: `tick errored (will retry): ${String(err).slice(0, 100)}` });
    } finally {
      this.accountUsage(peer, usageFrom, "tick", cwd);
      if (peer.mode === "goal" && peer.objective) this.evaluateGoal(peer, cwd);
      peer.busy = false;
      const ended = (peer.status as PeerStatus) === "done" || (peer.status as PeerStatus) === "exhausted";
      if ((peer.status as PeerStatus) !== "stopped" && !ended) {
        if (peer.status !== "error") peer.status = "waiting";
        this.scheduleTick(peer, this.backoffDelayMs(peer));
        this.refreshRoster(cwd);
      }
      this.notify();
    }
  }

  /** One report for a finished wave: every member's key, verdict and summary. */
  private deliverWave(waveId: string, members: Peer[], cwd: string): void {
    const ordered = [...members].sort((a, b) => (a.wave?.key ?? "").localeCompare(b.wave?.key ?? ""));
    const lines = ordered.map((m) => {
      const h = m.handoff;
      const verdict = m.status === "error" ? "FAILED" : m.gate ? (m.gatePassed ? "accepted" : "NOT ACCEPTED") : "done";
      const files = h?.changedFiles.length ? ` · changed ${h.changedFiles.join(", ")}` : "";
      const asks = h?.decisions.length ? ` · NEEDS YOU: ${h.decisions.join("; ")}` : "";
      return `${m.wave?.key ?? m.name} — ${verdict}: ${h?.summary ?? "no handoff"}${files}${asks}`;
    });
    const bad = ordered.filter((m) => m.status === "error" || (m.gate && !m.gatePassed) || (m.handoff?.decisions.length ?? 0) > 0);
    const body = `${ordered.length} task${ordered.length === 1 ? "" : "s"} finished (${ordered.length - bad.length} clean, ${bad.length} needing you)\n${lines.join("\n")}`;
    appendEvent(cwd, "wave.completed", { wave: waveId, size: ordered.length, needingAttention: bad.length, keys: ordered.map((m) => m.wave?.key) });
    const finding: Finding = {
      id: uid(), peer: ordered[0]?.name ?? "wave", tick: 0, ts: Date.now(), clamped: false,
      priority: bad.length > 0 ? "steering" : "info",
      body,
      refs: ordered.flatMap((m) => m.handoff?.changedFiles ?? []),
    };
    // Delivered through the ordinary path, attributed to the wave's first member so
    // the address in the transcript still resolves to a real, resumable agent.
    if (ordered[0]) this.deliver(ordered[0], finding, cwd);
  }

  /** Sum usage of assistant messages from index `fromIdx`; accumulate on the
   *  peer and ledger it. Defensive: providers differ in fields. */
  private accountUsage(peer: Peer, fromIdx: number, kind: "tick" | "ask", cwd: string): void {
    const msgs: any[] = peer.session.state?.messages ?? [];
    let inp = 0, out = 0, cost = 0;
    for (let i = fromIdx; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const u = m.usage ?? {};
      inp += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      out += u.output ?? 0;
      cost += u.cost?.total ?? 0;
    }
    if (inp === 0 && out === 0 && cost === 0) return;
    peer.usage.input += inp;
    peer.usage.output += out;
    peer.usage.costUsd += cost;
    appendEvent(cwd, "peer.usage", {
      peer: peer.name, exchange: kind, tick: peer.tickCount,
      input: inp, output: out, costUsd: Number(cost.toFixed(6)),
      totalInput: peer.usage.input, totalOutput: peer.usage.output, totalCostUsd: Number(peer.usage.costUsd.toFixed(6)),
    });
  }

  /** Every model call goes through here, so a provider failure is survivable in one
   *  place. A turn that comes back as a provider error (empty content, stopReason
   *  "error") is retried on the next model in the agent's fallback chain — the same
   *  failure that used to end a tick or a task silently. Nothing is faked: if the
   *  chain runs out, the failure stands and stays visible. */
  private async promptPeer(peer: Peer, text: string, cwd: string): Promise<void> {
    for (;;) {
      await peer.session.prompt(text);
      if (!this.lastTurnFailed(peer)) return;
      const next = peer.fallbackChain?.shift();
      if (!next) return; // chain exhausted: the failure remains a failure
      const from = peer.modelLabel;
      const res = await this.setPeerModel(peer.name, next);
      appendEvent(cwd, "peer.model-failover", { peer: peer.name, from, to: res.ok ? peer.modelLabel : next, applied: res.ok, remaining: peer.fallbackChain?.length ?? 0, reason: "provider error" });
      peer.pane.push({ kind: "note", text: res.ok ? `the model provider refused that turn — switched to ${peer.modelLabel} and retrying` : `could not switch to ${next}: ${res.message}` });
      this.notify();
      if (!res.ok) return;
      if (peer.status === "error") peer.status = "thinking";
    }
  }

  /** A provider-failed turn: pi records it as an assistant message with empty
   *  content and stopReason "error". */
  private lastTurnFailed(peer: Peer): boolean {
    const msgs: any[] = peer.session.state?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== "assistant") continue;
      return msgs[i]?.stopReason === "error";
    }
    return false;
  }

  /** Did the peer's most recent turn actually call tools? Distinguishes
   *  "still working" from "done but forgot the verdict line". */
  private usedToolsLastTurn(peer: Peer): boolean {
    const msgs: any[] = peer.session.state?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const blocks = Array.isArray(m.content) ? m.content : [];
      return blocks.some((b: any) => b?.type === "toolCall" || b?.type === "tool_use" || b?.type === "toolUse");
    }
    return false;
  }

  private lastAssistantText(peer: Peer): string {
    const msgs: any[] = peer.session.state?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") return textOfBlocks(msgs[i].content);
    }
    return "";
  }

  private parseVerdict(text: string): RegExpMatchArray | null {
    const matches = [...text.matchAll(/^\s*(QUIET\s*$|FINDING\[(info|steering|interrupt)\]\s*:\s*([\s\S]*))/gim)];
    return matches.length > 0 ? matches[matches.length - 1]! : null;
  }

  /** Goal bookkeeping: the FRAMEWORK decides completion. A peer
   *  claiming DONE while its condition is false is refused and keeps working. */
  private evaluateGoal(peer: Peer, cwd: string): void {
    if (!peer.objective) return;
    peer.cycles++;
    const met = objectiveMet(peer.objective, peer.watchCwd ?? cwd);
    const claimed = /\bDONE\b/.test(this.lastAssistantText(peer));
    if (!met && claimed) {
      appendEvent(cwd, "goal.claim-refused", { peer: peer.name, cycle: peer.cycles, condition: `${peer.objective.kind}:${peer.objective.value}` });
      peer.pane.push({ kind: "note", text: "the peer says it's finished, but the goal isn't met yet — still working" });
      this.notifyPeer(peer, "Your DONE claim was REFUSED: the framework evaluated your completion condition as still false. Keep working.", cwd, "goal-claim-refused");
    }
    if (met) {
      appendEvent(cwd, "goal.completed", { peer: peer.name, cycles: peer.cycles, condition: `${peer.objective.kind}:${peer.objective.value}` });
      peer.pane.push({ kind: "note", text: `✓ goal complete after ${peer.cycles} cycle${peer.cycles === 1 ? "" : "s"} — condition met` });
      this.endGoal(peer, cwd, "done");
      return;
    }
    const cap = peer.objective.maxCycles ?? 20;
    if (peer.cycles >= cap) {
      appendEvent(cwd, "goal.exhausted", { peer: peer.name, cycles: peer.cycles, condition: `${peer.objective.kind}:${peer.objective.value}` });
      peer.pane.push({ kind: "note", text: `goal exhausted after ${peer.cycles} cycles — condition never met` });
      this.endGoal(peer, cwd, "exhausted");
    }
  }

  /** A goal that ended stops ticking but keeps its session (resumable). */
  private endGoal(peer: Peer, cwd: string, status: "done" | "exhausted"): void {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    peer.status = status;
    this.refreshRoster(cwd);
    this.notify();
    const verb = status === "done" ? "completed" : "exhausted";
    // An agent telling its session that its objective ended is still an agent reaching the
    // session — the same direction, so the same rule.
    {
      const attempt: TalkAttempt = { from: "peer", fromName: peer.name, fromProject: cwd, to: "parent", toName: this.parentSessionId() ?? "the session", toProject: cwd };
      const verdict = judge(attempt, loadRules(cwd));
      appendEvent(cwd, "talk.judged", { from: peer.name, to: attempt.toName, direction: "peer->parent", via: "goal-ended", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
      if (!verdict.allowed) return;
    }
    this.pi.sendMessage(
      {
        customType: "peer-finding",
        content: `[peer-agent] goal ${verb}: ${peer.address} after ${peer.cycles} cycles · condition ${peer.objective?.kind}:${peer.objective?.value}\n\nLast report:\n${this.lastAssistantText(peer).slice(0, 1500)}`,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  private parentAddress(): string {
    return `agent://pi/${this.parentSessionId()}`;
  }

  private handleVerdict(
    peer: Peer,
    text: string,
    cwd: string,
    authority?: { ceiling?: Priority; floor?: Priority },
  ): void {
    const m = this.parseVerdict(text);
    if (!m) {
      peer.quietStreak++;
      appendEvent(cwd, "peer.malformed", { peer: peer.name, tick: peer.tickCount });
      peer.pane.push({ kind: "note", text: "couldn't read this tick's summary — treating it as nothing to report" });
      peer.backoffIdx = Math.min(peer.backoffIdx + 1, this.config.backoff.length - 1);
      return;
    }
    if (m[1]!.trim().startsWith("QUIET")) {
      peer.quietStreak++;
      peer.backoffIdx = Math.min(peer.backoffIdx + 1, this.config.backoff.length - 1);
      return;
    }
    const ceiling = authority?.ceiling ?? peer.role.priorityCeiling;
    const requested = (m[2] ?? "info") as Priority;
    const clamped = priorityRank(requested) > priorityRank(ceiling);
    let priority: Priority = clamped ? ceiling : requested;
    // Operator-relay floor: "tell the main agent X" means deliver NOW — an
    // info-priority relay would sit silently until the next natural turn.
    if (authority?.floor && priorityRank(priority) < priorityRank(authority.floor)) priority = authority.floor;
    const raw = (m[3] ?? "").trim().slice(0, 4000);
    if (!raw) return;
    const { body, refs } = splitRefs(raw);
    if (!body) return;

    peer.quietStreak = 0;
    peer.backoffIdx = 0;
    const finding: Finding = {
      id: uid(), peer: peer.name, priority, clamped, tick: peer.tickCount, body, ts: Date.now(),
      ...(refs.length > 0 ? { refs } : {}),
    };
    peer.findings.push(finding);
    peer.pane.push({ kind: "finding", text: body, priority });
    this.deliver(peer, finding, cwd);
  }

  /** the messaging contract mapped delivery. */
  private deliver(peer: Peer, finding: Finding, cwd: string): void {
    const header = `[peer-agent] finding from ${peer.address} (${finding.priority}${finding.clamped ? ", clamped" : ""}) · tick ${finding.tick} · id ${finding.id}${finding.refs?.length ? ` · refs: ${finding.refs.join(", ")}` : ""}`;
    const content = `${header}\n\n${finding.body}`;
    // peer→parent: an agent reaching the session it is bound to. The rules name this
    // direction, so it passes through them like the other two — otherwise the shipped
    // default permitting it would be a sentence nothing enforced.
    {
      const attempt: TalkAttempt = { from: "peer", fromName: peer.name, fromProject: cwd, to: "parent", toName: this.parentSessionId() ?? "the session", toProject: cwd };
      const verdict = judge(attempt, loadRules(cwd));
      appendEvent(cwd, "talk.judged", { from: peer.name, to: attempt.toName, direction: "peer->parent", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
      if (!verdict.allowed) {
        appendEvent(cwd, "finding.refused", { peer: peer.name, id: finding.id, why: refusalText(attempt, verdict) });
        peer.pane.push({ kind: "note", text: `finding not delivered — ${refusalText(attempt, verdict)}` });
        return;
      }
    }
    try {
      if (finding.priority === "interrupt") {
        // I1–I2: create the boundary, then redeliver at it.
        (this.ctx as any)?.abort?.();
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "steer", triggerTurn: true });
      } else if (finding.priority === "steering") {
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "steer", triggerTurn: true });
      } else {
        // info: appended at the next natural boundary; never wakes the operator.
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "nextTurn" });
      }
      // The receiving session is part of the record: without it, "did this land in the
      // right session?" cannot be answered from the ledger at all (an audit found a
      // check that could not fail because this field did not exist).
      appendEvent(cwd, "finding.delivered", { peer: peer.name, address: peer.address, session: this.parentSessionId(), id: finding.id, priority: finding.priority, clamped: finding.clamped, tick: finding.tick, body: finding.body.slice(0, 2000), ...(finding.refs?.length ? { refs: finding.refs } : {}) });
      // Delivery receipt: the peer learns on its next tick that this landed
      // (its own suggestion — relayed through the very channel it improves).
      this.notifyPeer(peer, `finding ${finding.id} (${finding.priority}) delivered to the main agent at ${new Date().toISOString()}`, cwd, "delivery-receipt");
      peer.pane.push({ kind: "note", text: `✓ delivered to main agent (${finding.priority})` });
    } catch (err) {
      appendEvent(cwd, "finding.failed", { peer: peer.name, id: finding.id, error: String(err).slice(0, 200) });
    }
  }

  /** Deliver a finding that arrived via the FILE INBOX (spec transport 2):
   *  written by a peer resumed standalone in another terminal. Same the messaging contract
   *  mapping as live findings, attributed with '(standalone)'. */
  deliverInboxFinding(msg: { peer?: string; priority?: string; body?: string }): boolean {
    const cwd = this.ctx?.cwd ?? process.cwd();
    const body = String(msg.body ?? "").trim();
    if (!body) return false;
    const peerName = String(msg.peer ?? "unknown-peer");
    const pr: Priority = msg.priority === "interrupt" ? "steering" : (msg.priority as Priority) ?? "info"; // interrupt via file demoted — no live session to justify an abort
    const parentId = this.parentSessionId();
    // The same direction, arriving by a different door: a finding written to the inbox by
    // an agent resumed in another terminal. A rule that governs one door and not the other
    // governs nothing.
    {
      const attempt: TalkAttempt = { from: "peer", fromName: peerName, fromProject: cwd, to: "parent", toName: parentId ?? "the session", toProject: cwd };
      const verdict = judge(attempt, loadRules(cwd));
      appendEvent(cwd, "talk.judged", { from: peerName, to: attempt.toName, direction: "peer->parent", via: "inbox", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
      if (!verdict.allowed) {
        appendEvent(cwd, "finding.refused", { peer: peerName, via: "inbox", why: refusalText(attempt, verdict) });
        return false;
      }
    }
    const header = `[peer-agent] finding from agent://pi/${parentId}/${peerName} (standalone, ${pr})`;
    const content = `${header}\n\n${body}`;
    try {
      if (pr === "steering") {
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "steer", triggerTurn: true });
      } else {
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "nextTurn" });
      }
      appendEvent(cwd, "inbox.delivered", { peer: peerName, priority: pr, chars: body.length });
      // Surface in the panel too if that peer happens to be active/known.
      const live = this.peers.get(peerName);
      if (live) {
        live.pane.push({ kind: "finding", text: `(standalone) ${body}`, priority: pr });
        this.notify();
      }
      return true;
    } catch (err) {
      appendEvent(cwd, "inbox.failed", { peer: peerName, error: String(err).slice(0, 200) });
      return false;
    }
  }


  /** A note the session leaves for an agent to read on its next tick. It is a message to
   *  that agent, so it passes the same rule as any other — an exemption for "receipts"
   *  would be a category the rules do not have. */
  private notifyPeer(peer: Peer, text: string, cwd: string, via: string): boolean {
    const attempt: TalkAttempt = { from: "parent", fromName: "the session", fromProject: cwd, to: "peer", toName: peer.name, toProject: cwd };
    const verdict = judge(attempt, loadRules(cwd));
    appendEvent(cwd, "talk.judged", { from: "the session", to: peer.name, direction: "parent->peer", via, allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
    if (!verdict.allowed) return false;
    peer.pendingReceipts.push(text);
    return true;
  }

  /** Direct conversation with an agent — outside the tick, no verdict, no delivery to the
   *  main agent. The exchange is written into the agent's real session file and its reply
   *  is RETURNED, so whoever asked can use the answer straight away.
   *
   *  `from` used to be a KIND — operator or main-agent — which could not express "the
   *  agent next to you". It is a sender now: those two words, or `peer:<name>` when one
   *  agent speaks to another, so the recipient's own transcript shows WHO spoke.
   */
  async ask(
    name: string,
    text: string,
    from: Sender = "operator",
  ): Promise<{ status: "ok" | "busy" | "missing" | "refused"; reply?: string }> {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return { status: "missing" };
    if (peer.busy) return { status: "busy" };
    // EVERY message passes the rules, not only agent-to-agent ones. Judging in the send
    // tool alone left the two directions the rules also name — a session addressing its
    // agents, and an agent answering back — outside the thing that claims to govern them.
    {
      const cwd = this.ctx?.cwd ?? process.cwd();
      const senderRaw = from.startsWith("peer:") ? from.slice(5) : from;
      const [senderName, senderHome] = senderRaw.split("@");
      const attempt: TalkAttempt = {
        from: from.startsWith("peer:") ? "peer" : "parent",
        fromName: from.startsWith("peer:") ? senderName : from,
        fromProject: senderHome ?? cwd,
        to: "peer",
        toName: name,
        toProject: cwd,
      };
      const verdict = judge(attempt, loadRules(attempt.fromProject));
      appendEvent(cwd, "talk.judged", {
        from: attempt.fromName, to: name, direction: `${attempt.from}->peer`,
        allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null,
      });
      if (!verdict.allowed) return { status: "refused", reply: refusalText(attempt, verdict) };
    }
    // A sender that names an agent must BE one. The type gives the shape; only this can
    // say the agent exists, and without it a message could arrive signed by anyone.
    if (from.startsWith("peer:")) {
      const claimed = from.slice(5);
      // A sender from ANOTHER project cannot be found among this session's agents; its
      // right to speak was already judged by the rules where it started.
      if (claimed.includes("@")) {
        appendEvent(this.ctx?.cwd ?? process.cwd(), "ask.crossed", { peer: name, from });
      } else {
      const real = this.peers.get(claimed);
      if (!real || real.status === "stopped") {
        appendEvent(this.ctx?.cwd ?? process.cwd(), "ask.refused", { peer: name, from, why: "the sender is not an agent of this session" });
        return { status: "missing" };
      }
      }
    }
    peer.busy = true;
    // An ENDED agent (a retired task, a completed or exhausted goal) can still be
    // asked questions, but answering must not put it back among the living: its
    // ending is a fact, not a status waiting to be overwritten (found while
    // proving the TASK kind, 2026-08-06).
    const endedStatus: PeerStatus | null = ["retired", "done", "exhausted"].includes(peer.status) ? peer.status : null;
    peer.status = "thinking";
    const senderPeer = from.startsWith("peer:") ? from.slice(5) : null;
    peer.pane.push({ kind: "user", text: senderPeer ? `[${senderPeer}] ${text}` : from === "main-agent" ? `[main agent] ${text}` : text });
    appendEvent(this.ctx?.cwd ?? process.cwd(), "ask.sent", { peer: name, from, chars: text.length });
    this.notify();
    let reply = "";
    try {
      const before = (peer.session.state?.messages ?? []).length;
      await this.promptPeer(peer,
        `DIRECT MESSAGE from ${senderPeer ? (senderPeer.includes("@") ? `${senderPeer.split("@")[0]}, an agent in another project (${senderPeer.split("@")[1]})` : `${senderPeer}, another agent in your crew`) : from === "main-agent" ? "the MAIN AGENT you are bound to" : "the human operator"} (conversational — answer directly and briefly IN TEXT after any tool use; this is not a tick, no verdict line): ${text}`, this.ctx?.cwd ?? process.cwd());
      // Last NON-EMPTY assistant text produced by THIS exchange — a message
      // that only carries a tool call must not shadow the actual answer
      // (a live regression probe caught exactly that).
      const msgs: any[] = peer.session.state?.messages ?? [];
      let modelError = "";
      for (let i = msgs.length - 1; i >= Math.min(before, msgs.length - 1); i--) {
        if (msgs[i]?.role === "assistant") {
          const t = textOfBlocks(msgs[i].content).trim();
          if (t) {
            reply = t;
            break;
          }
          if (!modelError && msgs[i]?.stopReason === "error" && msgs[i]?.errorMessage) {
            modelError = String(msgs[i].errorMessage);
          }
        }
      }
      // An assistant error has an empty content array. That used to be reported
      // as a successful 0-character reply, hiding rate limits for ~30 seconds
      // and making a latency benchmark look like delivery succeeded. Empty is
      // never success when the session itself recorded the error.
      if (!reply && modelError) reply = `(peer model error: ${modelError.slice(0, 240)})`;
      appendEvent(this.ctx?.cwd ?? process.cwd(), "ask.replied", { peer: name, from, chars: reply.length, error: Boolean(modelError && !textOfBlocks(msgs.at(-1)?.content).trim()) });
      this.accountUsage(peer, before, "ask", this.ctx?.cwd ?? process.cwd());
      this.refreshRoster(this.ctx?.cwd ?? process.cwd());
      // A FINDING line in an answer is a real push: deliver it to the main
      // agent like a tick finding (this is the peer's on-demand relay channel).
      // Operator authority outranks the role ceiling for these: a human-
      // requested relay may deliver at up to steering even from an info-
      // ceiling role (interrupt stays tick-only).
      const v = this.parseVerdict(reply);
      if (v && !v[1]!.trim().startsWith("QUIET")) {
        const authority = from === "operator" ? { ceiling: "steering" as Priority, floor: "steering" as Priority } : undefined;
        this.handleVerdict(peer, reply, this.ctx?.cwd ?? process.cwd(), authority);
      }
    } catch (err) {
      peer.pane.push({ kind: "note", text: `error: ${String(err).slice(0, 120)}` });
      reply = `(peer errored: ${String(err).slice(0, 120)})`;
    } finally {
      peer.busy = false;
      if ((peer.status as PeerStatus) !== "stopped") peer.status = endedStatus ?? "waiting";
      // Persist the settled status too: the in-memory panel showed "waiting"
      // while roster.json still said "thinking", so every reader outside this
      // session (CLI, census, other sessions) saw a permanently busy agent
      // until some unrelated write corrected it.
      this.refreshRoster(this.ctx?.cwd ?? process.cwd());
      this.notify();
    }
    return { status: "ok", reply };
  }

  /** Live model switch on a running peer (native session.setModel — the
   *  transcript and tick loop continue uninterrupted). */
  async setPeerModel(name: string, ref: string): Promise<{ ok: boolean; message: string }> {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return { ok: false, message: `no active peer named ${name}` };
    const registry: any = (this.ctx as any)?.modelRegistry;
    // Match against the same list the picker shows (scoped when configured).
    const names = this.listModels();
    const [prov, ...rest] = ref.split("/");
    let model: any = rest.length ? registry?.find?.(prov, rest.join("/")) : undefined;
    if (!model) {
      const q = ref.toLowerCase();
      const matches = names.filter((n) => n.toLowerCase().includes(q));
      if (matches.length === 1) {
        const [p, ...r] = matches[0]!.split("/");
        model = registry?.find?.(p, r.join("/"));
      } else if (matches.length > 1)
        return { ok: false, message: `ambiguous "${ref}": ${matches.slice(0, 6).join(", ")}${matches.length > 6 ? "…" : ""}` };
    }
    if (!model) return { ok: false, message: `no model matching "${ref}" among pi's available models` };
    try {
      await peer.session.setModel(model);
      const label = `${model.provider}/${model.id}`;
      peer.modelLabel = label;
      peer.pane.push({ kind: "note", text: `model → ${label}` });
      const cwd = this.ctx?.cwd ?? process.cwd();
      appendEvent(cwd, "peer.model", { peer: name, model: label });
      // The session changed immediately, but the roster used to keep reporting
      // the old model until some unrelated refresh. Every surface must agree
      // with the session at the moment the choice is applied.
      this.refreshRoster(cwd);
      this.notify();
      return { ok: true, message: `${name} now runs ${label}` };
    } catch (err) {
      return { ok: false, message: `setModel failed: ${String(err).slice(0, 160)}` };
    }
  }

  /** Models exactly as pi offers them: the session's SCOPED list when
   *  scoping is configured (same set as pi's /scoped-models and ctrl+p
   *  cycle), otherwise the full registry. */
  listModels(): string[] {
    const scoped: any[] = ((this.ctx as any)?.scopedModels ?? []) as any[];
    if (scoped.length > 0) return scoped.map((e: any) => `${e.model?.provider ?? e.provider}/${e.model?.id ?? e.id}`);
    const registry: any = (this.ctx as any)?.modelRegistry;
    return (registry?.getAll?.() ?? []).map((m: any) => `${m.provider}/${m.id}`);
  }

  /** Live tick-interval change for a running peer (seconds internally). */
  setTick(name: string, seconds: number): boolean {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return false;
    const tick = Math.max(60, Math.floor(seconds));
    peer.role = { ...peer.role, tick };
    peer.backoffIdx = 0;
    this.scheduleTick(peer, 1000);
    const cwd = this.ctx?.cwd ?? process.cwd();
    appendEvent(cwd, "peer.tick-changed", { peer: name, tickS: tick });
    peer.pane.push({ kind: "note", text: `tick → ${rhythmOf(peer)}` });
    this.refreshRoster(cwd);
    this.notify();
    return true;
  }

  /** Change an agent's standing task. Returns why it did NOT happen, so a refusal by a
   *  rule can be told apart from an agent that is not there — every caller reported both
   *  as the same silent false. */
  retaskWithReason(name: string, task: string): { ok: boolean; why?: string } {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return { ok: false, why: `no active agent named "${name}"` };
    const cwd = this.ctx?.cwd ?? process.cwd();
    const attempt: TalkAttempt = { from: "parent", fromName: "operator", fromProject: cwd, to: "peer", toName: name, toProject: cwd };
    const verdict = judge(attempt, loadRules(cwd));
    appendEvent(cwd, "talk.judged", { from: "operator", to: name, direction: "parent->peer", via: "retask", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
    if (!verdict.allowed) return { ok: false, why: refusalText(attempt, verdict) };
    peer.pendingRetask = task;
    peer.task = task;
    peer.backoffIdx = 0;
    appendEvent(cwd, "peer.retasked", { peer: name, task });
    this.scheduleTick(peer, 200);
    this.refreshRoster(cwd);
    this.notify();
    return { ok: true };
  }




  tellAll(text: string): number {
    const cwd = this.ctx?.cwd ?? process.cwd();
    let n = 0;
    for (const peer of this.active) {
      // The same direction as asking one agent, so the same question: saying it to
      // everyone at once must not be a way around the rule that governs saying it to one.
      const attempt: TalkAttempt = { from: "parent", fromName: "operator", fromProject: cwd, to: "peer", toName: peer.name, toProject: cwd };
      const verdict = judge(attempt, loadRules(cwd));
      appendEvent(cwd, "talk.judged", { from: "operator", to: peer.name, direction: "parent->peer", via: "tell-all", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
      if (!verdict.allowed) continue;
      peer.pendingRetask = `${peer.pendingRetask ? peer.pendingRetask + "\n" : ""}TO EVERY AGENT: ${text}`;
      peer.backoffIdx = 0;
      this.scheduleTick(peer, 300 + n * 500); // staggered
      n++;
    }
    if (this.ctx) appendEvent(this.ctx.cwd, "tell-all", { text: text.slice(0, 300), peers: n });
    return n;
  }

  /** Change a running agent's authority. Requires an explicit human action at
   *  the surface that calls this (/peer authority, panel /authority, pi-peer authority) -- there is no
   *  auto-elevation path anywhere in the system.
   *
   *  A session's tool set is fixed when the session is created, so raising
   *  authority rebuilds the agent's session with the new tools, preserving its
   *  role, task, objective and watch directory. That is disclosed to the caller
   *  rather than hidden: the agent gets a fresh session file. */
  async setAuthority(name: string, level: Authority): Promise<{ ok: boolean; message: string }> {
    const peer = this.peers.get(name);
    if (!peer) return { ok: false, message: `no such agent: ${name}` };
    const before: Authority = peer.role.authority ?? "read-only";
    if (before === level) return { ok: true, message: `${name} is already ${level}` };
    // A role can cap itself: an advisory role stays advisory even when a human
    // tries to elevate it. Refusal is recorded, never silent.
    const RANK: Record<Authority, number> = { "read-only": 0, write: 1, shell: 2 };
    const cap = peer.role.authorityCeiling;
    if (cap && RANK[level] > RANK[cap]) {
      appendEvent(this.ctx?.cwd ?? process.cwd(), "peer.authority-refused", { peer: name, from: before, requested: level, ceiling: cap, role: peer.role.name });
      return { ok: false, message: `${name} cannot be raised to ${level}: its role (${peer.role.name}) is capped at ${cap} — advisory by construction. Launch a builder-once if the job needs to change files.` };
    }
    const cwd = this.ctx?.cwd ?? process.cwd();
    const nextRole: PeerRole = { ...peer.role, authority: level, tools: AUTHORITY_TOOLS[level] };
    appendEvent(cwd, "peer.authority", { peer: name, from: before, to: level, by: "human" });
    try {
      const mod: any = await import("@earendil-works/pi-coding-agent");
      const sm = mod.SessionManager.create(cwd, await this.peerSessionDir(cwd));
      // A new SessionManager defers creating its file until the first assistant
      // reply. Authority rebuilds must still be resumable if stopped before the
      // next tick, so initialize the header through its public file loader.
      const freshFile = sm.getSessionFile?.();
      if (freshFile) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(freshFile, "", { flag: "wx" });
        sm.setSessionFile(freshFile);
      }
      const rebuilt = await this.assemblePeerSession(
        this.ctx as any, cwd, nextRole, peer.name, peer.address,
        (this.ctx as any)?.sessionManager?.getSessionId?.() ?? "unknown",
        sm, peer.modelLabel === "default" ? undefined : peer.modelLabel, peer.watchCwd,
      );
      try {
        peer.unsub?.();
        peer.session.dispose?.();
      } catch { /* replacing it anyway */ }
      peer.session = (rebuilt as any).session ?? rebuilt;
      peer.role = nextRole;
      peer.sessionFile = sm.getSessionFile?.() ?? peer.sessionFile;
      this.attachStream(peer);
      this.refreshRoster(cwd);
      this.onUpdate?.();
      return {
        ok: true,
        message: `${name}: ${before} → ${level} (tools: ${AUTHORITY_TOOLS[level].join(", ")}) · rebuilt session, scoped to ${peer.watchCwd ?? cwd}`,
      };
    } catch (err) {
      appendEvent(cwd, "peer.authority.failed", { peer: name, to: level, error: String(err).slice(0, 200) });
      return { ok: false, message: `could not change ${name} to ${level}: ${String(err).slice(0, 120)}` };
    }
  }

  async stop(name: string): Promise<boolean> {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return false;
    peer.status = "stopped";
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    try {
      await peer.session.abort?.();
    } catch { /* already idle */ }
    try {
      peer.unsub?.();
      peer.session.dispose?.();
    } catch { /* dispose is best-effort */ }
    const cwd = this.ctx?.cwd ?? process.cwd();
    appendEvent(cwd, "peer.stopped", { peer: name, ticks: peer.tickCount, findings: peer.findings.length });
    this.refreshRoster(cwd);
    this.notify();
    return true;
  }

  /** Kill: stop AND erase — roster entry removed, session file deleted.
   *  The irreversible sibling of stop (which keeps the session resumable). */
  async kill(name: string): Promise<boolean> {
    const peer = this.peers.get(name);
    if (!peer) return false;
    if (peer.status !== "stopped") await this.stop(name);
    this.peers.delete(name);
    const cwd = this.ctx?.cwd ?? process.cwd();
    try {
      const { unlinkSync, existsSync } = await import("node:fs");
      if (peer.sessionFile && existsSync(peer.sessionFile)) unlinkSync(peer.sessionFile);
    } catch {
      /* file removal is best-effort */
    }
    appendEvent(cwd, "peer.killed", { peer: name, sessionFile: peer.sessionFile });
    this.refreshRoster(cwd);
    this.notify();
    return true;
  }

  async stopAll(): Promise<void> {
    for (const p of [...this.peers.values()]) if (p.status !== "stopped") await this.stop(p.name);
  }
}
