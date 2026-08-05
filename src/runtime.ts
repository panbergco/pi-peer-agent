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
operator or the main agent ends your watch.`;

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

  /** Throttled: streaming fires per token, but the TUI repaints at most
   *  ~12 fps — token-rate full re-renders read as flicker. */
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
    }, 80);
  }

  private refreshRoster(cwd: string): void {
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
      status: p.status,
      startedAt: p.startedAt,
    }));
    writeRoster(cwd, entries);
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

  async launch(ctx: ExtensionContext, role: PeerRole, task: string, mode?: ContextMode, modelRef?: string): Promise<Peer> {
    this.ctx = ctx;
    const cwd = ctx.cwd;
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
    });

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
      "",
      PROTOCOL,
    ].join("\n");
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: mod.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const parentFile = this.parentSessionFile();
    const sm =
      contextMode === "fork" && parentFile
        ? mod.SessionManager.forkFrom(parentFile, cwd)
        : mod.SessionManager.create(cwd);

    const wanted = modelRef ?? role.model;
    let model: any = (ctx as any).model;
    if (wanted) {
      const [prov, ...rest] = wanted.split("/");
      model = (ctx as any).modelRegistry?.find?.(prov, rest.join("/")) ?? model;
    }
    const readOnly: any[] = mod.createReadOnlyTools(cwd).filter((t: any) => role.tools.includes(t.name));

    const { session } = await mod.createAgentSession({
      cwd,
      sessionManager: sm,
      model,
      modelRegistry: (ctx as any).modelRegistry,
      thinkingLevel: role.thinking ?? "low",
      noTools: "all",
      customTools: readOnly,
      resourceLoader,
    });

    const peer: Peer = {
      name, role, task, contextMode,
      modelLabel: model ? `${model.provider}/${model.id}` : "default",
      address, session,
      sessionId: sm.getSessionId?.() ?? "unknown",
      sessionFile: sm.getSessionFile?.() ?? "(in-memory)",
      status: "starting", tickCount: 0, quietStreak: 0, backoffIdx: 0,
      nextTickAt: Date.now(), timer: null, busy: false,
      watermark: ((ctx as any).sessionManager?.getEntries?.() ?? []).length,
      pane: [], findings: [], pendingRetask: null, unsub: null,
      startedAt: new Date().toISOString(),
    };
    // In fork mode the peer has the full lineage; watch from now. In other
    // modes the context brief covers history, so also watch from now.
    this.attachStream(peer);
    this.peers.set(name, peer);
    upsertAgentsBlock(cwd);
    this.refreshRoster(cwd);
    appendEvent(cwd, "peer.session", { peer: name, peerSessionId: peer.sessionId, peerSessionFile: peer.sessionFile });

    // Awareness notice in the main transcript (info — display only, no wake).
    this.pi.sendMessage(
      {
        customType: "peer-notice",
        content: `⇄ peer ${name} (${role.name}) is now watching — ${contextMode} context · tick ${Math.round(role.tick / 60)}m · ${peer.modelLabel}\n   resume standalone: pi --session ${peer.sessionFile}`,
        display: true,
      },
      { deliverAs: "nextTurn" },
    );

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
    parts.push(delta ? `DELTA — what the main agent did since your last look:\n${delta}` : `No conversation delta this tick.`);
    parts.push(`End with your verdict line (QUIET or FINDING[…]: …).`);

    try {
      await peer.session.prompt(parts.join("\n\n"));
      let text = "";
      const msgs: any[] = peer.session.state?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant") {
          text = textOfBlocks(msgs[i].content);
          break;
        }
      }
      this.handleVerdict(peer, text, cwd);
    } catch (err) {
      peer.status = "error";
      appendEvent(cwd, "peer.error", { peer: peer.name, tick: peer.tickCount, error: String(err).slice(0, 300) });
      peer.pane.push({ kind: "note", text: `error: ${String(err).slice(0, 120)}` });
    } finally {
      peer.busy = false;
      if (peer.status !== "stopped") {
        if (peer.status !== "error") peer.status = "waiting";
        this.scheduleTick(peer, this.backoffDelayMs(peer));
        this.refreshRoster(cwd);
      }
      this.notify();
    }
  }

  private parentAddress(): string {
    return `agent://pi/${this.parentSessionId()}`;
  }

  private handleVerdict(peer: Peer, text: string, cwd: string): void {
    const matches = [...text.matchAll(/^\s*(QUIET\s*$|FINDING\[(info|steering|interrupt)\]\s*:\s*([\s\S]*))/gim)];
    const m = matches.length > 0 ? matches[matches.length - 1] : null;
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
    const requested = (m[2] ?? "info") as Priority;
    const clamped = priorityRank(requested) > priorityRank(peer.role.priorityCeiling);
    const priority: Priority = clamped ? peer.role.priorityCeiling : requested;
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
      appendEvent(cwd, "finding.delivered", { peer: peer.name, id: finding.id, priority: finding.priority, clamped: finding.clamped, tick: finding.tick });
    } catch (err) {
      appendEvent(cwd, "finding.failed", { peer: peer.name, id: finding.id, error: String(err).slice(0, 200) });
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
    } catch (err) {
      peer.pane.push({ kind: "note", text: `error: ${String(err).slice(0, 120)}` });
      reply = `(peer errored: ${String(err).slice(0, 120)})`;
    } finally {
      peer.busy = false;
      if (peer.status !== "stopped") peer.status = "waiting";
      this.notify();
    }
    return { status: "ok", reply };
  }

  retask(name: string, task: string): boolean {
    const peer = this.peers.get(name);
    if (!peer || peer.status === "stopped") return false;
    peer.pendingRetask = task;
    peer.backoffIdx = 0;
    appendEvent(this.ctx?.cwd ?? process.cwd(), "peer.retasked", { peer: name, task });
    this.scheduleTick(peer, 200);
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

  async stopAll(): Promise<void> {
    for (const p of [...this.peers.values()]) if (p.status !== "stopped") await this.stop(p.name);
  }
}
