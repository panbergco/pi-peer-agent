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
import { discoverRoles } from "../src/roles.js";
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

  function toggleSidecar(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (sidecar) {
      if (sidecar.handle && !sidecar.handle.isFocused?.()) {
        sidecar.handle.focus();
        sidecar.component.focused = true;
      } else {
        sidecar.close();
      }
      return;
    }
    void openSidecar(ctx);
  }

  /** btw's resolveBtwModalDimensions pattern: ratio of the live terminal,
   *  clamped, returned absolute — recomputed every render via the
   *  overlayOptions-as-function hook, so resizes just work. */
  function overlayDims(tui: any) {
    const cols = Math.max(40, Number(tui?.terminal?.columns) || 120);
    const rows = Math.max(12, Number(tui?.terminal?.rows) || 36);
    const width = Math.max(80, Math.min(180, Math.floor(cols * config.overlayWidthRatio), cols - 2));
    const maxHeight = Math.max(20, Math.min(Math.floor(rows * config.overlayHeightRatio), rows - 2));
    return { anchor: "center" as const, width, maxHeight, margin: 1, nonCapturing: true as const };
  }

  async function openSidecar(ctx: ExtensionContext): Promise<void> {
    let overlayTui: any = null;
    try {
      await (ctx.ui as any).custom<void>(
        (tui: any, theme: any, _kb: any, done: (r: void) => void) => {
          overlayTui = tui;
          const component = new PeerSidecar({
            getPeers: () => manager.active,
            theme,
            onClose: () => done(undefined),
            onUnfocus: () => {
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              tui.requestRender();
            },
            onStop: (name: string) => {
              void manager.stop(name).then(() => tui.requestRender());
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
            getMaxRows: () => overlayDims(tui).maxHeight,
          });
          manager.onUpdate = () => tui.requestRender();
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
      sidecar?.component.dispose();
      sidecar = null;
      manager.onUpdate = null;
    }
  }

  // ------------------------------------------------------------- commands

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
          `roles: ${roles.map((r) => `${r.name} (${r.source}, tick ${r.tick}s, ≤${r.priorityCeiling})`).join(" · ") || "none found"}`,
          `active: ${manager.active.map((p) => `${p.name}[t${p.tickCount}${p.findings.length ? ` ◆${p.findings.length}` : ""}]`).join(" · ") || "none"}`,
          `usage: /peer (toggle sidecar) · /peer launch <role> <task…> [--fork|--compacted|--fresh] · /peer stop <name|all> · /peer retask <name> <task…> · /peer broadcast <text…>`,
        ];
        ui?.notify?.(lines.join("\n"), "info");
        return;
      }

      if (verb === "launch") {
        const roles = discoverRoles(ctx.cwd);
        let roleName = rest[0];
        let taskWords = rest.slice(1);
        let mode: any;
        taskWords = taskWords.filter((w) => {
          if (w === "--fork" || w === "--compacted" || w === "--fresh") {
            mode = w.slice(2);
            return false;
          }
          return true;
        });
        if (!roleName && ui?.select) {
          roleName = await ui.select(
            "Peer role",
            roles.map((r) => `${r.name} — ${r.description}`),
          );
          roleName = roleName?.split(" — ")[0];
        }
        const role = roles.find((r) => r.name === roleName);
        if (!role) {
          ui?.notify?.(`unknown role "${roleName ?? ""}" — /peer list shows what exists`, "error");
          return;
        }
        let task = taskWords.join(" ");
        if (!task && ui?.input) task = (await ui.input("Standing task for this peer", role.description)) ?? "";
        if (!task) task = role.description || "watch the main agent's work per your charter";
        const peer = await manager.launch(ctx, role, task, mode);
        ui?.notify?.(`⇄ ${peer.name} launched (${peer.contextMode}, tick ${role.tick}s) — ${peer.sessionId}`, "info");
        if (!sidecar) toggleSidecar(ctx);
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
    description: "toggle the peer sidecar",
    handler: (ctx: ExtensionContext) => {
      track(ctx);
      toggleSidecar(ctx);
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
    }),
    async execute(_id: string, params: any, _signal: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const role = discoverRoles(ctx.cwd).find((r) => r.name === params.role);
      if (!role) {
        const names = discoverRoles(ctx.cwd).map((r) => r.name).join(", ");
        return { content: [{ type: "text" as const, text: `Unknown role "${params.role}". Available: ${names}` }] };
      }
      const peer = await manager.launch(ctx, role, params.task, params.context);
      return {
        content: [{
          type: "text" as const,
          text: `Peer ${peer.name} launched: ${peer.address}\nsession ${peer.sessionId} (resume: pi --session ${peer.sessionFile})\ntick ${role.tick}s · ceiling ${role.priorityCeiling} · ${peer.contextMode} context`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "peer_roster",
    label: "Peer roster",
    description: "List available peer roles and currently active peers (addresses, tick state, findings).",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const roles = discoverRoles(ctx.cwd)
        .map((r) => `- ${r.name} (${r.source}): ${r.description} [tick ${r.tick}s, ≤${r.priorityCeiling}, ${r.context}]`)
        .join("\n");
      const active = manager.active
        .map((p) => `- ${p.name} (${p.role.name}) ${p.address} · tick ${p.tickCount} · ${p.status} · findings ${p.findings.length} · task: ${p.task}`)
        .join("\n");
      const persisted = readRoster(ctx.cwd);
      return {
        content: [{
          type: "text" as const,
          text: `ROLES:\n${roles || "(none)"}\n\nACTIVE PEERS:\n${active || "(none)"}${persisted.length && !manager.active.length ? `\n\nroster.json lists ${persisted.length} peers from a previous run` : ""}`,
        }],
      };
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
      return { content: [{ type: "text" as const, text: ok ? `${params.name} retasked.` : `No active peer named ${params.name}.` }] };
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
      return { content: [{ type: "text" as const, text: `Broadcast delivered to ${n} peer${n === 1 ? "" : "s"}.` }] };
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
        return { content: [{ type: "text" as const, text: "All peers stopped." }] };
      }
      const ok = await manager.stop(params.name);
      return { content: [{ type: "text" as const, text: ok ? `${params.name} stopped (session retained).` : `No active peer named ${params.name}.` }] };
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
