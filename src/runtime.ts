/** Peer runtime — resident sessions, tick engine, verdicts, push delivery.
 *  Spec: docs/peer-agent-spec.md §4 (identity/binding), §6 (tick), §7 (delivery).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextMode, Finding, PaneEntry, PeerConfig, PeerRole, PeerStatus, Priority, RosterEntry } from "./types.js";
import { priorityRank, shortId, uid } from "./types.js";
import { appendEvent, upsertAgentsBlock, writeRoster } from "./state.js";

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
  /** Delivery receipts queued for the peer's next tick prompt. */
  pendingReceipts: string[];
  /** Watch directory: file tools rooted here when set (E1, spec 12.1). */
  watchCwd?: string;
  unsub: (() => void) | null;
  startedAt: string;
}

const PANE_CAP = 400;

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** Serialize parent-session entries appended since the watermark (spec §6.2). */
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
without emitting that line. Delivery receipts for your findings arrive in your next tick prompt;
you can also verify any delivery yourself in .pi/peer-agent/events.jsonl (finding.delivered).`;

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

  get active(): Peer[] {
    return [...this.peers.values()].filter((p) => p.status !== "stopped");
  }

  private renderPending = false;
  private providerExtsCache: { extensions: any[]; runtime: any } | null | undefined;

  /** Load auth/provider extensions for peer sessions (once, cached). Without
   *  these, models whose providers are registered by extensions (devin) fail
   *  with 'No API key' inside peers while working in the main session. */
  private async loadProviderExtensions(cwd: string): Promise<{ extensions: any[]; runtime: any } | null> {
    if (this.providerExtsCache !== undefined) return this.providerExtsCache;
    try {
      const { readFileSync, existsSync } = await import("node:fs");
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
      for (const name of names) {
        const pkgDir = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", name);
        const pkgJson = path.join(pkgDir, "package.json");
        if (!existsSync(pkgJson)) continue;
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
        for (const rel of pkg?.pi?.extensions ?? []) {
          const abs = path.resolve(pkgDir, rel);
          if (existsSync(abs)) entryPaths.push(abs);
        }
      }
      if (entryPaths.length === 0) {
        this.providerExtsCache = null;
        return null;
      }
      const result = await loader.loadExtensions(entryPaths, cwd);
      for (const e of result.errors ?? []) appendEvent(cwd, "provider-ext.error", { path: e.path, error: String(e.error).slice(0, 200) });
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
      tickBaseS: p.role.tick,
      status: p.status,
      startedAt: p.startedAt,
      ...(p.watchCwd ? { watchCwd: p.watchCwd } : {}),
    }));
    writeRoster(cwd, entries);
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
    const systemPrompt = [
      `You are ${name}, a resident PEER MONITOR (role: ${role.name}) bound to a main pi agent session (agent://pi/${parentId}).`,
      `Your address: ${address}. The roster of sibling peers lives at .pi/peer-agent/roster.json.`,
      "",
      role.charter,
      "",
      `You have read-only tools (${role.tools.join(", ")}) — inspect the repository to verify suspicions before reporting. You cannot modify anything.`,
      ...(watchCwd && watchCwd !== cwd
        ? ["", `Your file tools are rooted at ${watchCwd} (your WATCH DIRECTORY) — relative paths resolve there, not at the main project root.`]
        : []),
      "",
      PROTOCOL,
    ].join("\n");
    const providerExts = await this.loadProviderExtensions(cwd);
    const resourceLoader = {
      getExtensions: () => ({
        extensions: providerExts?.extensions ?? [],
        errors: [],
        runtime: providerExts?.runtime ?? mod.createExtensionRuntime(),
      }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
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
    const readOnly: any[] = mod.createReadOnlyTools(toolsCwd).filter((t: any) => role.tools.includes(t.name));
    const { session } = await mod.createAgentSession({
      cwd: toolsCwd,
      sessionManager: sm,
      model,
      modelRegistry: (ctx as any).modelRegistry,
      thinkingLevel: role.thinking ?? "low",
      noTools: "all",
      customTools: readOnly,
      resourceLoader,
    });
    return { session, model };
  }

  /** Session teardown that PRESERVES the crew in roster.json as 'suspended'
   *  — peers are part of the session and come back on recover(). */
  async suspendAll(): Promise<void> {
    const cwd = this.ctx?.cwd ?? process.cwd();
    const entries: RosterEntry[] = this.active.map((p) => ({
      name: p.name,
      role: p.role.name,
      address: p.address,
      peerSessionId: p.sessionId,
      peerSessionFile: p.sessionFile,
      parentSessionId: this.parentSessionId(),
      task: p.task,
      contextMode: p.contextMode,
      model: p.modelLabel,
      tickBaseS: p.role.tick,
      status: "suspended" as PeerStatus,
      startedAt: p.startedAt,
    }));
    if (entries.length > 0) writeRoster(cwd, entries);
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

  /** Revive this session's suspended crew from roster.json — each peer
   *  resumes its OWN session file with full memory. */
  async recover(ctx: ExtensionContext): Promise<number> {
    this.setCtx(ctx);
    const cwd = ctx.cwd;
    const { readRoster } = await import("./state.js");
    const { discoverRoles } = await import("./roles.js");
    const { existsSync } = await import("node:fs");
    const parentId = this.parentSessionId();
    const entries = readRoster(cwd).filter(
      (e) => e.parentSessionId === parentId && e.status !== "stopped" && !this.peers.has(e.name),
    );
    if (entries.length === 0) return 0;
    const mod: any = await import("@earendil-works/pi-coding-agent");
    const roles = discoverRoles(cwd);
    let recovered = 0;
    for (const entry of entries) {
      try {
        if (!existsSync(entry.peerSessionFile)) {
          appendEvent(cwd, "peer.recover-failed", { peer: entry.name, reason: "session file missing" });
          continue;
        }
        const baseRole = roles.find((r) => r.name === entry.role);
        if (!baseRole) {
          appendEvent(cwd, "peer.recover-failed", { peer: entry.name, reason: `role ${entry.role} not found` });
          continue;
        }
        const role: PeerRole = { ...baseRole, tick: entry.tickBaseS || baseRole.tick };
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
          startedAt: entry.startedAt,
          ...(entry.watchCwd ? { watchCwd: entry.watchCwd } : {}),
        };
        // Callsign counter continuity (sentinel-2 must not collide).
        const suffix = Number.parseInt(entry.name.split("-").pop() ?? "", 10);
        const base = entry.name.replace(/-\d+$/, "");
        if (Number.isFinite(suffix)) this.counters.set(base, Math.max(this.counters.get(base) ?? 0, suffix));
        peer.pane.push({ kind: "note", text: `recovered with session — watch continues (${entry.contextMode}, tick ${Math.round(role.tick / 60)}m)` });
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

  private callsign(role: PeerRole): string {
    const base = role.name.includes("-") ? role.name.split("-").pop()! : role.name;
    const n = (this.counters.get(base) ?? 0) + 1;
    this.counters.set(base, n);
    return `${base}-${n}`;
  }

  /** Compacted context brief: latest compaction summary if present, else a trimmed transcript tail (D-09). */
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

  async launch(ctx: ExtensionContext, role: PeerRole, task: string, mode?: ContextMode, modelRef?: string, watchCwd?: string): Promise<Peer> {
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
      contextMode, task, model: modelRef ?? role.model ?? "parent", tickBaseS: role.tick,
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
      ...(watchCwd ? { watchCwd } : {}),
      sessionId: sm.getSessionId?.() ?? "unknown",
      sessionFile: sm.getSessionFile?.() ?? "(in-memory)",
      status: "starting", tickCount: 0, quietStreak: 0, backoffIdx: 0,
      nextTickAt: Date.now(), timer: null, busy: false,
      watermark: ((ctx as any).sessionManager?.getEntries?.() ?? []).length,
      pane: [], findings: [], pendingRetask: null, pendingReceipts: [], unsub: null,
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
    this.scheduleTick(peer, 100); // first tick almost immediately
    this.notify();
    return peer;
  }

  private attachStream(peer: Peer): void {
    const push = (entry: PaneEntry) => {
      peer.pane.push(entry);
      if (peer.pane.length > PANE_CAP) peer.pane.splice(0, peer.pane.length - PANE_CAP);
      this.notify();
    };
    peer.unsub = peer.session.subscribe((ev: any) => {
      try {
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

    if (!delta && !retask && peer.tickCount > 0 && !peer.role.tickWithoutDelta) {
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
    if (retask) parts.push(`RETASK from the main agent: ${retask}`);
    if (peer.pendingReceipts.length > 0) {
      parts.push(`DELIVERY RECEIPTS since your last tick:\n${peer.pendingReceipts.join("\n")}`);
      peer.pendingReceipts = [];
    }
    parts.push(delta ? `DELTA — what the main agent did since your last look:\n${delta}` : `No conversation delta this tick.`);
    parts.push(`End with your verdict line (QUIET or FINDING[…]: …).`);

    try {
      await peer.session.prompt(parts.join("\n\n"));
      let text = this.lastAssistantText(peer);
      // One re-ask on a malformed verdict: the common failure is a model
      // that did tool calls and forgot the closing line — a single nudge
      // recovers it; a second failure degrades to QUIET as before.
      if (!this.parseVerdict(text)) {
        appendEvent(cwd, "peer.verdict-reask", { peer: peer.name, tick: peer.tickCount });
        await peer.session.prompt("Your verdict line was missing. Reply NOW with only the verdict line: QUIET or FINDING[info|steering|interrupt]: <paragraph>.");
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
      peer.busy = false;
      if ((peer.status as PeerStatus) !== "stopped") {
        if (peer.status !== "error") peer.status = "waiting";
        this.scheduleTick(peer, this.backoffDelayMs(peer));
        this.refreshRoster(cwd);
      }
      this.notify();
    }
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
      peer.pane.push({ kind: "note", text: "malformed verdict → treated as QUIET" });
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
    const body = (m[3] ?? "").trim().slice(0, 4000);
    if (!body) return;

    peer.quietStreak = 0;
    peer.backoffIdx = 0;
    const finding: Finding = { id: uid(), peer: peer.name, priority, clamped, tick: peer.tickCount, body, ts: Date.now() };
    peer.findings.push(finding);
    peer.pane.push({ kind: "finding", text: body, priority });
    this.deliver(peer, finding, cwd);
  }

  /** MACP §8 mapped delivery (spec §7). */
  private deliver(peer: Peer, finding: Finding, cwd: string): void {
    const header = `[peer-agent] finding from ${peer.address} (${finding.priority}${finding.clamped ? ", clamped" : ""}) · tick ${finding.tick} · id ${finding.id}`;
    const content = `${header}\n\n${finding.body}`;
    try {
      if (finding.priority === "interrupt") {
        // I1–I2: create the boundary, then redeliver at it.
        (this.ctx as any)?.abort?.();
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "steer", triggerTurn: true });
      } else if (finding.priority === "steering") {
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "steer", triggerTurn: true });
      } else {
        // info: appended at the next natural boundary; never wakes (D-08).
        this.pi.sendMessage({ customType: "peer-finding", content, display: true }, { deliverAs: "nextTurn" });
      }
      appendEvent(cwd, "finding.delivered", { peer: peer.name, id: finding.id, priority: finding.priority, clamped: finding.clamped, tick: finding.tick, body: finding.body.slice(0, 2000) });
      // Delivery receipt: the peer learns on its next tick that this landed
      // (its own suggestion — relayed through the very channel it improves).
      peer.pendingReceipts.push(`finding ${finding.id} (${finding.priority}) delivered to the main agent at ${new Date().toISOString()}`);
      peer.pane.push({ kind: "note", text: `✓ delivered to main agent (${finding.priority})` });
    } catch (err) {
      appendEvent(cwd, "finding.failed", { peer: peer.name, id: finding.id, error: String(err).slice(0, 200) });
    }
  }

  /** Deliver a finding that arrived via the FILE INBOX (spec §9 transport 2):
   *  written by a peer resumed standalone in another terminal. Same MACP
   *  mapping as live findings, attributed with '(standalone)'. */
  deliverInboxFinding(msg: { peer?: string; priority?: string; body?: string }): boolean {
    const cwd = this.ctx?.cwd ?? process.cwd();
    const body = String(msg.body ?? "").trim();
    if (!body) return false;
    const peerName = String(msg.peer ?? "unknown-peer");
    const pr: Priority = msg.priority === "interrupt" ? "steering" : (msg.priority as Priority) ?? "info"; // interrupt via file demoted — no live session to justify an abort
    const parentId = this.parentSessionId();
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

  /** Direct conversation with a peer — outside the tick, no verdict, no
   *  delivery. The exchange is recorded in the peer's real session file and
   *  the peer's reply is RETURNED, so the main agent can consult its helpers
   *  synchronously. `from` names the sender for attribution. */
  async talk(
    name: string,
    text: string,
    from: "operator" | "main-agent" = "operator",
  ): Promise<{ status: "ok" | "busy" | "missing"; reply?: string }> {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return { status: "missing" };
    if (peer.busy) return { status: "busy" };
    peer.busy = true;
    peer.status = "thinking";
    peer.pane.push({ kind: "user", text: from === "main-agent" ? `[main agent] ${text}` : text });
    appendEvent(this.ctx?.cwd ?? process.cwd(), "talk.sent", { peer: name, from, chars: text.length });
    this.notify();
    let reply = "";
    try {
      await peer.session.prompt(
        `DIRECT MESSAGE from the ${from === "main-agent" ? "MAIN AGENT you are bound to" : "human operator"} (conversational — answer directly and briefly; this is not a tick, no verdict line): ${text}`,
      );
      const msgs: any[] = peer.session.state?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant") {
          reply = textOfBlocks(msgs[i].content);
          break;
        }
      }
      appendEvent(this.ctx?.cwd ?? process.cwd(), "talk.replied", { peer: name, from, chars: reply.length });
      // A FINDING line in a talk reply is a real push: deliver it to the main
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
      if ((peer.status as PeerStatus) !== "stopped") peer.status = "waiting";
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
      appendEvent(this.ctx?.cwd ?? process.cwd(), "peer.model", { peer: name, model: label });
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
    peer.pane.push({ kind: "note", text: `tick → every ${Math.round(tick / 60)}m` });
    this.refreshRoster(cwd);
    this.notify();
    return true;
  }

  retask(name: string, task: string): boolean {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return false;
    peer.pendingRetask = task;
    peer.task = task; // the standing task IS the new task — roster/status must say so
    peer.backoffIdx = 0;
    const cwd = this.ctx?.cwd ?? process.cwd();
    appendEvent(cwd, "peer.retasked", { peer: name, task });
    this.scheduleTick(peer, 200);
    this.refreshRoster(cwd);
    this.notify();
    return true;
  }

  broadcast(text: string): number {
    let n = 0;
    for (const peer of this.active) {
      peer.pendingRetask = `${peer.pendingRetask ? peer.pendingRetask + "\n" : ""}BROADCAST: ${text}`;
      peer.backoffIdx = 0;
      this.scheduleTick(peer, 300 + n * 500); // staggered
      n++;
    }
    if (this.ctx) appendEvent(this.ctx.cwd, "broadcast", { text: text.slice(0, 300), peers: n });
    return n;
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
