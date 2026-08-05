/** pi-peer-agent — extension entry (spec docs/peer-agent-spec.md).
 *
 * Resident peer agents: standing objectives on a seconds-tick, real resumable
 * pi sessions, findings pushed into the main session at inference boundaries
 * (MACP 2.0 delivery contract). Pi-native surfaces only: registered tools,
 * slash commands, a shortcut, and an overlay sidecar — no MCP, no tmux, no
 * child processes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverRoles, parseTick } from "../src/roles.js";
import { PeerManager } from "../src/runtime.js";
import { PeerSidecar } from "../src/sidecar.js";
import { loadConfig, readRoster } from "../src/state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function piPeerAgent(pi: ExtensionAPI) {
  const config = loadConfig();
  const manager = new PeerManager(pi, config);
  let lastCtx: ExtensionContext | null = null;
  let sidecar: { component: PeerSidecar; handle: any; close: () => void } | null = null;

  const track = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    manager.setCtx(ctx);
  };

  // ------------------------------------------------------------- sidecar

  /** Bare /peer: strict open/close toggle — closing must ALWAYS work,
   *  regardless of focus state. */
  function toggleSidecar(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (sidecar) {
      sidecar.close();
      return;
    }
    void openSidecar(ctx);
  }

  /** Shortcut: closed → open · open+unfocused → focus · open+focused → close. */
  function shortcutToggle(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!sidecar) {
      void openSidecar(ctx);
      return;
    }
    if (sidecar.handle && !sidecar.handle.isFocused?.()) {
      sidecar.handle.focus();
      sidecar.component.focused = true;
    } else {
      sidecar.close();
    }
  }

  /** Interactive launch (used by bare `/peer launch` and the sidecar's `l`). */
  async function interactiveLaunch(ctx: ExtensionContext): Promise<void> {
    const ui: any = ctx.ui;
    if (!ui?.select) return;
    const roles = discoverRoles(ctx.cwd);
    if (roles.length === 0) {
      ui.notify?.("no peer roles found (peers/*.md)", "error");
      return;
    }
    const pick = await ui.select("Peer role", roles.map((r) => `${r.name} — ${r.description}`));
    if (!pick) return;
    const role = roles.find((r) => pick.startsWith(r.name));
    if (!role) return;
    const task = (await ui.input("Standing task for this peer", role.description)) || role.description || "watch the main agent's work per your charter";
    const modePick = await ui.select("Context for the peer", [
      `compacted — summary of this conversation so far${role.context === "compacted" ? " (role default)" : ""}`,
      `fork — full copy of this session's history${role.context === "fork" ? " (role default)" : ""}`,
      `fresh — blank slate${role.context === "fresh" ? " (role default)" : ""}`,
    ]);
    const mode = modePick?.split(" ")[0] as any;
    const peer = await manager.launch(ctx, role, task, mode);
    ui.notify?.(`${peer.name} launched (${peer.contextMode}, tick ${Math.round(role.tick / 60)}m)`, "info");
    if (!sidecar) void openSidecar(ctx);
  }

  /** btw's resolveBtwModalDimensions pattern: ratio of the live terminal,
   *  clamped, returned absolute — recomputed every render via the
   *  overlayOptions-as-function hook, so resizes just work. */
  function overlayDims(tui: any) {
    const cols = Math.max(40, Number(tui?.terminal?.columns) || 120);
    const rows = Math.max(12, Number(tui?.terminal?.rows) || 36);
    // Clamp by the terminal LAST — the overlay must never exceed the screen.
    const width = Math.min(cols - 2, Math.max(80, Math.min(180, Math.floor(cols * config.overlayWidthRatio))));
    const maxHeight = Math.min(rows - 2, Math.max(20, Math.floor(rows * config.overlayHeightRatio)));
    // top-center anchor ONLY (no row/margin interplay): the panel's position
    // never depends on its content height. maxHeight includes crop headroom —
    // the component renders 3 rows fewer than this budget, so the bottom
    // border survives the overlay's own accounting.
    return { anchor: "top-center" as const, offsetY: 1, width, maxHeight, nonCapturing: true as const };
  }

  async function openSidecar(ctx: ExtensionContext): Promise<void> {
    let overlayTui: any = null;
    // 1 Hz countdown refresh while the panel is open — cheap under pi's
    // differential renderer, keeps `next Ns` live without streaming churn.
    let countdown: ReturnType<typeof setInterval> | null = null;
    try {
      await (ctx.ui as any).custom(
        (tui: any, theme: any, kb: any, done: (r: void) => void) => {
          overlayTui = tui;
          const component = new PeerSidecar({
            tui,
            theme,
            keybindings: kb ?? { matches: () => false },
            getPeers: () => manager.active,
            getRoles: () => discoverRoles(ctx.cwd),
            // Crop headroom: render 3 rows under the overlay budget so the
            // bottom border always paints (verified by screenshot loop).
            getMaxRows: () => overlayDims(tui).maxHeight - 3,
            onClose: () => done(undefined),
            onUnfocus: () => {
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              tui.requestRender();
            },
            onStop: (name: string) => {
              void manager.stop(name).then(() => tui.requestRender());
            },
            onLaunch: () => {
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              void interactiveLaunch(lastCtx ?? ctx);
            },
            onLaunchDirect: (roleName: string, task: string) => {
              const role = discoverRoles(ctx.cwd).find((r) => r.name === roleName);
              if (!role) {
                (lastCtx ?? ctx).ui?.notify?.(`unknown role "${roleName}" — /peer list`, "error");
                return;
              }
              void manager.launch(lastCtx ?? ctx, role, task).then(() => tui.requestRender());
            },
            onTalk: (name: string, text: string) => {
              void manager.talk(name, text, "operator").then((res) => {
                if (res.status !== "ok") (lastCtx ?? ctx).ui?.notify?.(`${name}: ${res.status}`, "warning");
                tui.requestRender();
              });
            },
            onRetask: (name: string, task: string) => {
              manager.retask(name, task);
              (lastCtx ?? ctx).ui?.notify?.(`${name} retasked`, "info");
            },
            insertText: (text: string) => {
              const ui: any = (lastCtx ?? ctx).ui;
              if (ui?.pasteToEditor) ui.pasteToEditor(text);
              else if (ui?.setEditorText) ui.setEditorText(`${ui.getEditorText?.() ?? ""}${text}`);
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              ui?.notify?.("finding inserted into prompt", "info");
              tui.requestRender();
            },
            yankText: (text: string, label: string) => {
              void (async () => {
                try {
                  const mod: any = await import("@earendil-works/pi-coding-agent");
                  await mod.copyToClipboard(text);
                  (lastCtx ?? ctx).ui?.notify?.(`${label} copied`, "info");
                } catch {
                  (lastCtx ?? ctx).ui?.notify?.("clipboard unavailable", "warning");
                }
              })();
            },
            requestRender: () => tui.requestRender(),
          });
          manager.onUpdate = () => tui.requestRender();
          countdown = setInterval(() => {
            if (manager.active.length > 0) tui.requestRender();
          }, 1000);
          sidecar = { component, handle: null, close: () => done(undefined) };
          return component as any;
        },
        {
          overlay: true,
          overlayOptions: () => overlayDims(overlayTui),
          onHandle: (handle: any) => {
            if (sidecar) {
              sidecar.handle = handle;
              handle.focus();
              sidecar.component.focused = true;
            }
          },
        },
      );
    } finally {
      if (countdown) clearInterval(countdown);
      sidecar?.component.dispose();
      sidecar = null;
      manager.onUpdate = null;
    }
  }

  // ------------------------------------------------------------- commands

  // Alias: /peers toggles the panel too — "peers" names the crew.
  pi.registerCommand("peers", {
    description: "toggle the peers panel (alias of bare /peer)",
    handler: async (_args: unknown, ctx: ExtensionContext) => {
      track(ctx);
      toggleSidecar(ctx);
    },
  });

  pi.registerCommand("peer", {
    description: "peers: (bare = toggle sidecar) | launch <role> <task> | stop <name|all> | retask <name> <task> | broadcast <text> | list",
    handler: async (args: unknown, ctx: ExtensionContext) => {
      track(ctx);
      const ui: any = ctx.ui;
      const argv = String(args ?? "").trim();
      const [verb, ...rest] = argv.split(/\s+/).filter(Boolean);

      if (!verb) {
        toggleSidecar(ctx);
        return;
      }

      if (verb === "list") {
        const roles = discoverRoles(ctx.cwd);
        const lines = [
          `roles: ${roles.map((r) => `${r.name} (${r.source}, tick ${Math.round(r.tick / 60)}m, ≤${r.priorityCeiling})`).join(" · ") || "none found"}`,
          `active: ${manager.active.map((p) => `${p.name}[t${p.tickCount}${p.findings.length ? ` ◆${p.findings.length}` : ""}]`).join(" · ") || "none"}`,
          `usage: /peer (toggle sidecar) · /peer launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>] · /peer talk <name> <text…> · /peer stop <name|all> · /peer retask <name> <task…> · /peer broadcast <text…>`,
        ];
        ui?.notify?.(lines.join("\n"), "info");
        return;
      }

      if (verb === "launch") {
        const roles = discoverRoles(ctx.cwd);
        let taskWords = rest.slice(1);
        let mode: any;
        let tickOverride: number | undefined;
        taskWords = taskWords.filter((w, i, arr) => {
          if (w === "--fork" || w === "--compacted" || w === "--fresh") {
            mode = w.slice(2);
            return false;
          }
          if (w === "--tick") return false;
          if (arr[i - 1] === "--tick") {
            tickOverride = parseTick(w); // minutes by default: --tick 15 = 15m
            return false;
          }
          return true;
        });
        if (!rest[0]) {
          await interactiveLaunch(ctx);
          return;
        }
        const role = roles.find((r) => r.name === rest[0]);
        if (!role) {
          ui?.notify?.(`unknown role "${rest[0]}" — /peer list shows what exists`, "error");
          return;
        }
        let task = taskWords.join(" ");
        if (!task && ui?.input) task = (await ui.input("Standing task for this peer", role.description)) ?? "";
        if (!task) task = role.description || "watch the main agent's work per your charter";
        const effRole = tickOverride ? { ...role, tick: tickOverride } : role;
        const peer = await manager.launch(ctx, effRole, task, mode);
        ui?.notify?.(`${peer.name} launched (${peer.contextMode}, tick ${Math.round(effRole.tick / 60)}m) — ${peer.sessionId}`, "info");
        if (!sidecar) void openSidecar(ctx);
        return;
      }

      if (verb === "stop") {
        const target = rest[0];
        if (target === "all") {
          await manager.stopAll();
          ui?.notify?.("all peers stopped", "info");
        } else if (target && (await manager.stop(target))) {
          ui?.notify?.(`${target} stopped`, "info");
        } else {
          ui?.notify?.(`no active peer named "${target ?? ""}"`, "error");
        }
        return;
      }

      if (verb === "talk") {
        const name = rest[0] ?? "";
        const text = rest.slice(1).join(" ");
        if (!text) {
          ui?.notify?.("usage: /peer talk <name> <message…>", "error");
          return;
        }
        const res = await manager.talk(name, text, "operator");
        if (res.status === "missing") ui?.notify?.(`no active peer named "${name}"`, "error");
        else if (res.status === "busy") ui?.notify?.(`${name} is mid-tick — try again in a moment`, "warning");
        else if (!sidecar) toggleSidecar(ctx); // the reply streams in the panel
        return;
      }

      if (verb === "retask") {
        const name = rest[0] ?? "";
        const task = rest.slice(1).join(" ");
        if (manager.retask(name, task)) ui?.notify?.(`${name} retasked`, "info");
        else ui?.notify?.(`no active peer named "${name}"`, "error");
        return;
      }

      if (verb === "broadcast") {
        const n = manager.broadcast(rest.join(" "));
        ui?.notify?.(`broadcast to ${n} peer${n === 1 ? "" : "s"}`, "info");
        return;
      }

      ui?.notify?.(`unknown verb "${verb}" — /peer list for usage`, "error");
    },
  });

  pi.registerShortcut(config.toggleKey as any, {
    description: "peer sidecar: open → focus → close",
    handler: (ctx: ExtensionContext) => {
      track(ctx);
      shortcutToggle(ctx);
    },
  });

  // ---------------------------------------------------------------- tools

  pi.registerTool({
    name: "peer_launch",
    label: "Launch peer",
    description:
      "Launch a resident peer agent: a monitor with a standing objective that ticks every few seconds, " +
      "inspects this session's recent work, and pushes findings back as attributed messages. " +
      "Roles are defined in peers/*.md. The peer is a real resumable pi session.",
    parameters: Type.Object({
      role: Type.String({ description: "Role name (see peer_roster for available roles)." }),
      task: Type.String({ description: "The standing task, e.g. 'watch for scope creep vs the mission'." }),
      context: Type.Optional(Type.String({ description: "fork | compacted | fresh (default: role's choice)" })),
      tickMinutes: Type.Optional(Type.Number({ description: "Override this peer's tick interval in MINUTES (min 1). Each peer has its own. The framework issues ticks; the peer itself can never change this." })),
    }),
    async execute(_id: string, params: any, _signal: unknown, _u: unknown, ctx: any) {
      track(ctx);
      let role = discoverRoles(ctx.cwd).find((r) => r.name === params.role);
      if (!role) {
        const names = discoverRoles(ctx.cwd).map((r) => r.name).join(", ");
        return { content: [{ type: "text" as const, text: `Unknown role "${params.role}". Available: ${names}` }], details: {} };
      }
      if (params.tickMinutes) role = { ...role, tick: Math.max(60, Math.floor(params.tickMinutes * 60)) };
      const peer = await manager.launch(ctx, role, params.task, params.context);
      return {
        content: [{
          type: "text" as const,
          text: `Peer ${peer.name} launched: ${peer.address}\nsession ${peer.sessionId} (resume: pi --session ${peer.sessionFile})\ntick ${Math.round(role.tick / 60)}m · ceiling ${role.priorityCeiling} · ${peer.contextMode} context`,
        }], details: {},
      };
    },
  });

  pi.registerTool({
    name: "peer_roster",
    label: "Peer roster",
    description:
      "List available peer roles and active peers. Pass name for the FULL picture of one peer: " +
      "status, task, every finding with its body, recent activity, and the standalone resume command — " +
      "the same view the human has in the peers panel.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Peer callsign for deep detail (e.g. sentinel-1)." })),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      if (params.name) {
        const p = manager.peers.get(params.name);
        if (!p || p.status === "stopped") {
          return { content: [{ type: "text" as const, text: `No active peer named ${params.name}.` }], details: {} };
        }
        const etaS = Math.max(0, Math.round((p.nextTickAt - Date.now()) / 1000));
        const findings = p.findings.length
          ? p.findings.map((f) => `  [tick ${f.tick} · ${f.priority}${f.clamped ? " (clamped)" : ""} · ${new Date(f.ts).toISOString()}]\n  ${f.body}`).join("\n\n")
          : "  (none yet)";
        const recent = p.pane.slice(-25).map((e) => `  ${e.kind === "user" ? "❯ " : ""}${e.text}`).join("\n") || "  (no activity)";
        return {
          content: [{
            type: "text" as const,
            text: [
              `${p.name} (${p.role.name}) — ${p.status}`,
              `address: ${p.address}`,
              `task: ${p.task}`,
              `tick: every ${Math.round(p.role.tick / 60)}m · completed ${p.tickCount} · next in ~${etaS >= 90 ? Math.ceil(etaS / 60) + "m" : etaS + "s"} · quiet streak ${p.quietStreak}`,
              `context: ${p.contextMode} · model: ${p.modelLabel}`,
              `session: ${p.sessionId}`,
              `resume standalone: pi --session ${p.sessionFile}`,
              ``,
              `FINDINGS (${p.findings.length}):`,
              findings,
              ``,
              `RECENT ACTIVITY:`,
              recent,
            ].join("\n"),
          }], details: {},
      };
      }
      const roles = discoverRoles(ctx.cwd)
        .map((r) => `- ${r.name} (${r.source}): ${r.description} [tick ${Math.round(r.tick / 60)}m, ≤${r.priorityCeiling}, ${r.context}]`)
        .join("\n");
      const active = manager.active
        .map((p) => `- ${p.name} (${p.role.name}) · ${p.status} · tick ${p.tickCount} · findings ${p.findings.length} · task: ${p.task}`)
        .join("\n");
      const persisted = readRoster(ctx.cwd);
      return {
        content: [{
          type: "text" as const,
          text: `ROLES:\n${roles || "(none)"}\n\nACTIVE PEERS (peer_roster with name for full detail):\n${active || "(none)"}${persisted.length && !manager.active.length ? `\n\nroster.json lists ${persisted.length} peers from a previous run` : ""}`,
        }], details: {},
      };
    },
  });

  pi.registerTool({
    name: "peer_panel",
    label: "Peer panel",
    description:
      "Control the human-visible peers panel: open it (optionally focused on one peer) or close it. " +
      "Use to surface a peer's live pane to the human — e.g. after a finding worth their eyes.",
    parameters: Type.Object({
      action: Type.String({ description: "open | close" }),
      peer: Type.Optional(Type.String({ description: "Peer callsign to select + expand when opening." })),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      if (!ctx.hasUI) return { content: [{ type: "text" as const, text: "No interactive UI in this session mode." }], details: {} };
      if (params.action === "close") {
        if (sidecar) sidecar.close();
        return { content: [{ type: "text" as const, text: "Panel closed." }], details: {} };
      }
      if (!sidecar) void openSidecar(lastCtx ?? ctx);
      // Selection may need the panel a beat to mount.
      const target = params.peer;
      if (target) {
        setTimeout(() => sidecar?.component.selectPeer(target), 300);
      }
      return { content: [{ type: "text" as const, text: `Panel opened${target ? ` on ${target}` : ""}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_talk",
    label: "Talk to peer",
    description:
      "Send a direct message to one of your peer helpers and get its reply. Peers are long-running " +
      "monitors bound to this session — consult them like colleagues: ask the observer what happened, " +
      "ask the auditor to double-check a claim, ask a sentinel for its current read. The exchange is " +
      "recorded in the peer's own session.",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. sentinel-1 (see peer_roster)." }),
      message: Type.String({ description: "Your message or question to the peer." }),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const res = await manager.talk(params.name, params.message, "main-agent");
      if (res.status === "missing") return { content: [{ type: "text" as const, text: `No active peer named ${params.name}. Use peer_roster to list peers, or peer_launch to spawn one.` }], details: {} };
      if (res.status === "busy") return { content: [{ type: "text" as const, text: `${params.name} is mid-tick right now — retry in a few seconds.` }], details: {} };
      return { content: [{ type: "text" as const, text: `${params.name} replies:\n\n${res.reply || "(empty reply)"}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_retask",
    label: "Retask peer",
    description: "Change or refine an active peer's standing task. Takes effect on its next tick (immediate).",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. sentinel-1" }),
      task: Type.String({ description: "The new or additional instruction." }),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const ok = manager.retask(params.name, params.task);
      return { content: [{ type: "text" as const, text: ok ? `${params.name} retasked.` : `No active peer named ${params.name}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_broadcast",
    label: "Broadcast to peers",
    description: "Send one instruction to every active peer (project-scope broadcast, MACP tier 3).",
    parameters: Type.Object({ text: Type.String({ description: "The broadcast content." }) }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const n = manager.broadcast(params.text);
      return { content: [{ type: "text" as const, text: `Broadcast delivered to ${n} peer${n === 1 ? "" : "s"}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_stop",
    label: "Stop peer",
    description: "Stop an active peer (its session file remains resumable).",
    parameters: Type.Object({ name: Type.String({ description: "Peer callsign, or 'all'." }) }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      if (params.name === "all") {
        await manager.stopAll();
        return { content: [{ type: "text" as const, text: "All peers stopped." }], details: {} };
      }
      const ok = await manager.stop(params.name);
      return { content: [{ type: "text" as const, text: ok ? `${params.name} stopped (session retained).` : `No active peer named ${params.name}.` }], details: {} };
    },
  });

  // ---------------------------------------------------------------- events

  pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("turn_start", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("turn_end", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("session_shutdown", async () => {
    await manager.stopAll();
    sidecar?.close();
  });
}
