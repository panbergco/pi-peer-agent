/** pi-peer-agent — extension entry (spec docs/peer-agent-spec.md).
 *
 * Resident peer agents: standing objectives on a seconds-tick, real resumable
 * pi sessions, findings pushed into the main session at inference boundaries
 * (MACP 2.0 delivery contract). Pi-native surfaces only: registered tools,
 * slash commands, a shortcut, and an overlay sidecar — no MCP, no tmux, no
 * child processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverRoles, parseTick } from "../src/roles.js";
import { PeerManager } from "../src/runtime.js";
import { PeerSidecar } from "../src/sidecar.js";
import { appendEvent, loadConfig, readRoster, resetEventSink, setEventSink, type PeerEvent } from "../src/state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function piPeerAgent(pi: ExtensionAPI) {
  const config = loadConfig();
  const manager = new PeerManager(pi, config);
  let lastCtx: ExtensionContext | null = null;
  let sidecar: { component: PeerSidecar; handle: any; tui?: any; close: () => void } | null = null;

  const track = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    manager.setCtx(ctx);
  };

  // ------------------------------------------------------------- sidecar

  /** Bare /peer: strict open/close toggle — closing must ALWAYS work,
   *  regardless of focus state. */
  function toggleSidecar(ctx: ExtensionContext, focus = false): void {
    if (!ctx.hasUI) return;
    if (sidecar) {
      sidecar.close();
      return;
    }
    void openSidecar(ctx, { focus });
  }

  /** ctrl+alt+p = SHOW/HIDE toggle (final operator ruling). Opening always
   *  focuses; Esc hands keys back to the main prompt; /peers is the backup
   *  open/close. */
  function shortcutToggle(ctx: ExtensionContext): void {
    toggleSidecar(ctx);
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
    const tickAnswer = await ui.input(`Tick interval in minutes (role default ${Math.round(role.tick / 60)})`, String(Math.round(role.tick / 60)));
    const tickMin = Number.parseInt(tickAnswer ?? "", 10);
    const effRole = Number.isFinite(tickMin) && tickMin >= 1 ? { ...role, tick: tickMin * 60 } : role;
    const peer = await manager.launch(ctx, effRole, task, mode);
    ui.notify?.(`${peer.name} launched (${peer.contextMode}, tick ${Math.round(effRole.tick / 60)}m)`, "info");
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



  async function openSidecar(ctx: ExtensionContext, opts?: { focus?: boolean }): Promise<void> {
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
            getModels: () => manager.listModels(),
            getForeignAgents: () => {
              const mine = new Set(manager.all.map((p) => p.name));
              return readRoster(ctx.cwd)
                .filter((r) => !mine.has(r.name))
                .map((r) => ({ name: r.name, role: r.role, status: r.status, mode: r.mode }));
            },
            onTick: (name: string, minutes: number) => {
              if (manager.setTick(name, minutes * 60)) (lastCtx ?? ctx).ui?.notify?.(`${name}: tick → ${minutes}m`, "info");
            },
            onClose: () => done(undefined),
            onUnfocus: () => {
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              tui.requestRender();
            },
            onStop: (name: string) => {
              void manager.stop(name).then(() => tui.requestRender());
            },
            onKill: (name: string) => {
              void manager.kill(name).then(() => tui.requestRender());
            },
            onLaunch: () => {
              sidecar?.handle?.unfocus?.();
              if (sidecar) sidecar.component.focused = false;
              void interactiveLaunch(lastCtx ?? ctx);
            },
            onLaunchDirect: (roleName: string, task: string) => {
              const role = discoverRoles(ctx.cwd).find((r) => r.name === roleName);
              if (!role) {
                (lastCtx ?? ctx).ui?.notify?.(`unknown role "${roleName}" — /peers list`, "error");
                return;
              }
              // Support --tick <min> anywhere in the task words.
              let tickOverride: number | undefined;
              let watchDir: string | undefined;
              const words = task.split(/\s+/).filter((w, i, arr) => {
                if (w === "--tick" || w === "--watch") return false;
                if (arr[i - 1] === "--tick") {
                  tickOverride = parseTick(w);
                  return false;
                }
                if (arr[i - 1] === "--watch") {
                  watchDir = path.resolve((lastCtx ?? ctx).cwd, w);
                  return false;
                }
                return true;
              });
              const effRole = tickOverride ? { ...role, tick: tickOverride } : role;
              void manager.launch(lastCtx ?? ctx, effRole, words.join(" "), undefined, undefined, watchDir).then(() => tui.requestRender());
            },
            onTalk: (name: string, text: string) => {
              void manager.talk(name, text, "operator").then((res) => {
                if (res.status !== "ok") (lastCtx ?? ctx).ui?.notify?.(`${name}: ${res.status}`, "warning");
                tui.requestRender();
              });
            },
            onModel: (name: string, query: string) => {
              void (async () => {
                const uiCtx = lastCtx ?? ctx;
                const models = manager.listModels();
                const q = query.trim().toLowerCase();
                const filtered = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
                if (filtered.length === 0) {
                  uiCtx.ui?.notify?.(`no model matching "${query}"`, "error");
                  return;
                }
                let choice = filtered[0]!;
                if (filtered.length > 1) {
                  sidecar?.handle?.unfocus?.();
                  if (sidecar) sidecar.component.focused = false;
                  const picked = await (uiCtx.ui as any)?.select?.(`Model for ${name} (${filtered.length} available in pi)`, filtered);
                  if (!picked) return;
                  choice = picked;
                }
                const res = await manager.setPeerModel(name, choice);
                uiCtx.ui?.notify?.(res.message, res.ok ? "info" : "error");
                if (filtered.length > 1) {
                  sidecar?.handle?.focus?.();
                  if (sidecar) sidecar.component.focused = true;
                }
              })();
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
          // Repaint ONLY when the visible countdown text actually changes
          // (once a second while showing seconds, once a MINUTE while
          // showing minutes) — blanket 1Hz repaints read as flicker.
          let lastSig = "";
          countdown = setInterval(() => {
            const sig =
              manager.active
                .map((p) => {
                  const s = Math.max(0, Math.round((p.nextTickAt - Date.now()) / 1000));
                  return `${p.name}:${p.busy ? "busy" : s >= 90 ? `${Math.ceil(s / 60)}m` : `${s}s`}`;
                })
                .join("|") +
              // Include the project census: agents launched by ANOTHER session
              // must appear without waiting for a local event (IP-06).
              "#" + readRoster(ctx.cwd).map((r) => `${r.name}:${r.status}`).join(",");
            if (sig !== lastSig) {
              lastSig = sig;
              tui.requestRender();
            }
          }, 1000);
          sidecar = { component, handle: null, tui, close: () => done(undefined) };
          return component as any;
        },
        {
          overlay: true,
          // nonCapturing: showing the panel must NOT steal focus from the main
          // prompt. Focus-stealing changes the main layout (footer/hints), and
          // pi then reflows the WHOLE transcript -- in a long session that
          // reflow reads as "it reloaded/scrolled". Ctrl+Alt+L grants focus
          // deliberately; that is when a layout change is expected and wanted.
          overlayOptions: () => ({ ...overlayDims(overlayTui), nonCapturing: !opts?.focus }),
          onHandle: (handle: any) => {
            if (sidecar) {
              sidecar.handle = handle;
              if (opts?.focus) {
                handle.focus();
                sidecar.component.focused = true;
              } else {
                sidecar.component.focused = false;
              }
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

  // E3: hosts (e.g. a larger automation system, or a proof producer) attach an
  // in-process consumer for every peer event. Fan-out only — the JSONL ledger
  // is always still written, so file and store can never disagree.
  (globalThis as any).piPeerAgent = {
    setEventSink: (fn: ((e: PeerEvent, cwd: string) => void) | null) => setEventSink(fn),
    resetEventSink: () => resetEventSink(),
    version: 1,
  };

  pi.registerCommand("peers", {
    description: "peers: (bare = toggle sidecar) | launch <role> <task> | talk <name> <text> | stop <name|all> | kill <name> | retask <name> <task> | broadcast <text> | list",
    // Main-editor argument autocomplete — verbs, then roles/callsigns per verb
    // (same UX as pi's own commands; the panel input has its own provider).
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.split(/\s+/);
      const verb = words[0] ?? "";
      const VERBS: Array<[string, string]> = [
        ["launch", "<role> <task…> [--tick <min>] [--fork|--compacted|--fresh]"],
        ["talk", "<name> <message…> — converse; reply lands in the panel"],
        ["retask", "<name> <task…> — give a peer a new standing task"],
        ["broadcast", "<text…> — instruct every active peer"],
        ["stop", "<name|all> — end the watch (session kept, resumable)"],
        ["kill", "<name> — end the watch AND delete the session"],
        ["list", "crew + available roles"],
      ];
      if (words.length <= 1) {
        const hits = VERBS.filter(([v]) => v.startsWith(verb));
        return hits.length > 0 ? hits.map(([v, d]) => ({ value: v, label: v, description: d })) : null;
      }
      const argPrefix = words[1] ?? "";
      const cwd = lastCtx?.cwd ?? process.cwd();
      if (verb === "launch" && words.length === 2) {
        const roles = discoverRoles(cwd).filter((r) => r.name.startsWith(argPrefix));
        return roles.length > 0
          ? roles.map((r) => ({ value: `launch ${r.name}`, label: r.name, description: `${r.description} · tick ${Math.round(r.tick / 60)}m` }))
          : null;
      }
      if ((verb === "talk" || verb === "retask" || verb === "stop" || verb === "kill") && words.length === 2) {
        const names = manager.active.map((p) => ({ name: p.name, desc: `${p.role.name} · ${p.status}` }));
        if (verb === "stop") names.push({ name: "all", desc: "every active peer" });
        const hits = names.filter((n) => n.name.startsWith(argPrefix));
        return hits.length > 0 ? hits.map((n) => ({ value: `${verb} ${n.name}`, label: n.name, description: n.desc })) : null;
      }
      return null;
    },
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
          `usage: /peers (toggle panel) · /peers launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>] · /peers talk <name> <text…> · /peers stop <name|all> · /peers kill <name> · /peers retask <name> <task…> · /peers broadcast <text…>`,
        ];
        ui?.notify?.(lines.join("\n"), "info");
        return;
      }

      if (verb === "launch") {
        // --watch <dir> anywhere in the args roots the peer's file tools there (E1).
        const roles = discoverRoles(ctx.cwd);
        let taskWords = rest.slice(1);
        let mode: any;
        let tickOverride: number | undefined;
        let watchCwd: string | undefined;
        let objective: { kind: "file" | "exit0"; value: string; maxCycles?: number } | undefined;
        let maxCycles = Number.NaN;
        taskWords = taskWords.filter((w, i, arr) => {
          if (w === "--fork" || w === "--compacted" || w === "--fresh") {
            mode = w.slice(2);
            return false;
          }
          if (w === "--tick" || w === "--watch") return false;
          if (arr[i - 1] === "--tick") {
            tickOverride = parseTick(w); // minutes by default: --tick 15 = 15m
            return false;
          }
          if (arr[i - 1] === "--watch") {
            watchCwd = path.resolve(ctx.cwd, w);
            return false;
          }
          if (w === "--until-file" || w === "--until-exit0" || w === "--max-cycles") return false;
          if (arr[i - 1] === "--until-file") {
            objective = { kind: "file", value: w };
            return false;
          }
          if (arr[i - 1] === "--until-exit0") {
            objective = { kind: "exit0", value: w };
            return false;
          }
          if (arr[i - 1] === "--max-cycles") {
            maxCycles = Number.parseInt(w, 10);
            return false;
          }
          return true;
        });
        if (objective && Number.isFinite(maxCycles)) objective.maxCycles = maxCycles;
        if (!rest[0]) {
          await interactiveLaunch(ctx);
          return;
        }
        const role = roles.find((r) => r.name === rest[0]);
        if (!role) {
          ui?.notify?.(`unknown role "${rest[0]}" — /peers list shows what exists`, "error");
          return;
        }
        let task = taskWords.join(" ");
        if (!task && ui?.input) task = (await ui.input("Standing task for this peer", role.description)) ?? "";
        if (!task) task = role.description || "watch the main agent's work per your charter";
        const effRole = tickOverride ? { ...role, tick: tickOverride } : role;
        const peer = await manager.launch(ctx, effRole, task, mode, undefined, watchCwd, objective);
        ui?.notify?.(
          `${peer.name} launched (${peer.mode}${peer.objective ? ` until ${peer.objective.kind}:${peer.objective.value}` : ""}, ${peer.contextMode}, tick ${Math.round(effRole.tick / 60)}m${watchCwd ? `, watching ${watchCwd}` : ""})`,
          "info",
        );
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
          ui?.notify?.("usage: /peers talk <name> <message…>", "error");
          return;
        }
        const res = await manager.talk(name, text, "operator");
        if (res.status === "missing") ui?.notify?.(`no active peer named "${name}"`, "error");
        else if (res.status === "busy") ui?.notify?.(`${name} is mid-tick — try again in a moment`, "warning");
        else if (!sidecar) toggleSidecar(ctx); // the reply streams in the panel
        return;
      }

      if (verb === "kill") {
        const name = rest[0] ?? "";
        const ok = await manager.kill(name);
        ui?.notify?.(ok ? `${name} killed — watch ended, session deleted` : `no peer named "${name}"`, ok ? "info" : "error");
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

      ui?.notify?.(`unknown verb "${verb}" — /peers list for usage`, "error");
    },
  });

  pi.registerShortcut(config.toggleKey as any, {
    description: "peers panel: show/hide",
    handler: (ctx: ExtensionContext) => {
      track(ctx);
      shortcutToggle(ctx);
    },
  });

  pi.registerShortcut(config.focusKey as any, {
    description: "peers panel: move keyboard between panel and main prompt",
    handler: (ctx: ExtensionContext) => {
      track(ctx);
      if (!ctx.hasUI) return;
      if (!sidecar) {
        void openSidecar(ctx, { focus: true }); // the focus key opens focused
        return;
      }
      // Visibility mode is a NON-capturing overlay (so opening never reflows
      // the transcript). Real focus requires a capturing overlay — that is
      // also what makes pi suppress the main prompt's cursor, leaving exactly
      // one cursor on screen. So granting focus = reopen in capturing mode;
      // the crew state lives in the manager, not the overlay, so nothing is lost.
      if (sidecar.handle && !sidecar.handle.isFocused?.()) {
        sidecar.handle.focus();
        sidecar.component.focused = true;
        sidecar.tui?.requestRender?.();
      }
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
      cwd: Type.Optional(Type.String({ description: "Watch directory: root the peer's read-only file tools at this path (e.g. an executor worktree) instead of the project root." })),
      untilFile: Type.Optional(Type.String({ description: "MISSION mode: work in cycles until this file exists, then report DONE with evidence and retire. Framework-evaluated." })),
      untilExit0: Type.Optional(Type.String({ description: "MISSION mode: work in cycles until this shell command exits 0. Framework-evaluated, never self-asserted." })),
      maxCycles: Type.Optional(Type.Number({ description: "MISSION mode: give up after this many cycles (default 20)." })),
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
          // Not active — serve history: roster identity + findings from the ledger.
          const entry = readRoster(ctx.cwd).find((e) => e.name === params.name);
          const ledgerPath = path.join(ctx.cwd, ".pi", "peer-agent", "events.jsonl");
          const findings: string[] = [];
          try {
            const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").slice(-1000);
            for (const line of lines) {
              try {
                const e = JSON.parse(line);
                if ((e.kind === "finding.delivered" || e.kind === "inbox.delivered") && e.peer === params.name && e.body)
                  findings.push(`  [${e.kind === "inbox.delivered" ? "standalone · " : ""}tick ${e.tick ?? "?"} · ${e.priority} · ${e.ts}]\n  ${e.body}`);
              } catch { /* skip bad line */ }
            }
          } catch { /* no ledger */ }
          const text = entry || findings.length
            ? [
                `${params.name} — NOT ACTIVE${entry ? ` (last status: ${entry.status})` : ""}`,
                entry ? `was: ${entry.role} · task: ${entry.task}\nresume standalone: pi --session ${entry.peerSessionFile}` : "",
                ``,
                `LEDGER FINDINGS (${findings.length}):`,
                findings.join("\n\n") || "  (none recorded with bodies)",
              ].join("\n")
            : `No peer named ${params.name} — active or historical.`;
          return { content: [{ type: "text" as const, text }], details: {} };
        }
        const etaS = Math.max(0, Math.round((p.nextTickAt - Date.now()) / 1000));
        const findings = p.findings.length
          ? p.findings.map((f) => `  [tick ${f.tick} · ${f.priority}${f.clamped ? " (clamped)" : ""} · ${new Date(f.ts).toISOString()}]${f.refs?.length ? `\n  refs: ${f.refs.join(", ")}` : ""}\n  ${f.body}`).join("\n\n")
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
              `usage: ${p.usage.input} in · ${p.usage.output} out · $${p.usage.costUsd.toFixed(4)}`,
              p.mode === "mission"
                ? `mode: MISSION · condition ${p.objective?.kind}:${p.objective?.value} · cycles ${p.cycles}/${p.objective?.maxCycles ?? 20} · ${p.status}`
                : `mode: watch (standing)`,
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
      // CENSUS (IP-06): every agent this surface launched — live, ended, or
      // from a previous session — so nothing this project runs is hidden.
      const live = manager.all;
      const liveNames = new Set(live.map((p) => p.name));
      const census = [
        ...live.map(
          (p) =>
            `- ${p.name} [${p.mode}] (${p.role.name}) · ${p.status} · ${p.mode === "mission" ? `cycles ${p.cycles}/${p.objective?.maxCycles ?? 20} until ${p.objective?.kind}:${p.objective?.value}` : `tick ${p.tickCount}`} · findings ${p.findings.length} · $${p.usage.costUsd.toFixed(3)} · task: ${p.task}`,
        ),
        ...readRoster(ctx.cwd)
          .filter((r) => !liveNames.has(r.name))
          .map(
            (r) =>
              `- ${r.name} [${r.mode ?? "watch"}] (${r.role}) · ${r.status} (from durable state) · task: ${r.task} · resume: pi --session ${r.peerSessionFile}`,
          ),
      ].join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `ROLES:\n${roles || "(none)"}\n\nAGENT CENSUS — every agent launched through this surface (peer_roster with name for full detail):\n${census || "(none)"}`,
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
    name: "peer_model",
    label: "Peer model",
    description:
      "Change a running peer's model live (transcript and tick loop continue). Accepts provider/id or a " +
      "unique substring; the available set mirrors pi's own model registry.",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. sentinel-1." }),
      model: Type.String({ description: "provider/model-id or unique substring (e.g. 'glm-5-2')." }),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const res = await manager.setPeerModel(params.name, params.model);
      return { content: [{ type: "text" as const, text: res.message }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_retask",
    label: "Retask peer",
    description: "Change or refine an active peer's standing task. Takes effect on its next tick (immediate).",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. sentinel-1" }),
      task: Type.String({ description: "The new or additional instruction." }),
      tickMinutes: Type.Optional(Type.Number({ description: "Also change this peer's tick interval (minutes, min 1)." })),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const ok = manager.retask(params.name, params.task);
      if (ok && params.tickMinutes) manager.setTick(params.name, Math.floor(params.tickMinutes * 60));
      return { content: [{ type: "text" as const, text: ok ? `${params.name} retasked${params.tickMinutes ? ` (tick → ${params.tickMinutes}m)` : ""}.` : `No active peer named ${params.name}.` }], details: {} };
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

  /** True when the CURRENT session is itself a peer's session (resumed
   *  standalone via `pi --session <peer file>`). */
  function standalonePeerEntry(ctx: ExtensionContext): any | null {
    try {
      const sid = (ctx as any).sessionManager?.getSessionId?.();
      if (!sid) return null;
      return readRoster(ctx.cwd).find((e) => e.peerSessionId === sid) ?? null;
    } catch {
      return null;
    }
  }

  function appendControlAck(cwd: string, payload: Record<string, unknown>): void {
    appendEvent(cwd, "control.applied", payload);
  }

  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let peerMode: any = null; // roster entry when this session IS a peer

  function inboxDir(cwd: string): string {
    return path.join(cwd, ".pi", "peer-agent", "inbox");
  }

  /** Apply one CLI control command (from .pi/peer-agent/control/) and ack
   *  through the ledger so `pi-peer` can print the outcome. */
  async function applyControl(ctx: ExtensionContext, cmd: any): Promise<{ ok: boolean; message: string; reply?: string }> {
    switch (cmd.action) {
      case "launch": {
        const role = discoverRoles(ctx.cwd).find((r) => r.name === cmd.role);
        if (!role) return { ok: false, message: `unknown role "${cmd.role}"` };
        const eff = cmd.tickMinutes ? { ...role, tick: Math.max(60, Math.floor(cmd.tickMinutes * 60)) } : role;
        const obj = cmd.untilFile
          ? { kind: "file" as const, value: String(cmd.untilFile), maxCycles: cmd.maxCycles }
          : cmd.untilExit0
            ? { kind: "exit0" as const, value: String(cmd.untilExit0), maxCycles: cmd.maxCycles }
            : undefined;
        const peer = await manager.launch(ctx, eff, String(cmd.task ?? role.description), cmd.context, undefined, cmd.watchCwd ? path.resolve(ctx.cwd, String(cmd.watchCwd)) : undefined, obj);
        return { ok: true, message: `${peer.name} launched (${peer.mode}${peer.objective ? ` until ${peer.objective.kind}:${peer.objective.value}` : ""}, tick ${Math.round(eff.tick / 60)}m) · resume: pi --session ${peer.sessionFile}` };
      }
      case "talk": {
        const res = await manager.talk(String(cmd.name), String(cmd.message), "operator");
        if (res.status !== "ok") return { ok: false, message: `${cmd.name}: ${res.status}` };
        return { ok: true, message: `${cmd.name} replied:`, reply: res.reply ?? "(empty)" };
      }
      case "retask": {
        const ok = manager.retask(String(cmd.name), String(cmd.task));
        if (ok && cmd.tickMinutes) manager.setTick(String(cmd.name), Math.floor(cmd.tickMinutes * 60));
        return ok ? { ok: true, message: `${cmd.name} retasked${cmd.tickMinutes ? ` (tick → ${cmd.tickMinutes}m)` : ""}` } : { ok: false, message: `no active peer ${cmd.name}` };
      }
      case "tick": {
        const ok = manager.setTick(String(cmd.name), Math.floor(Number(cmd.minutes) * 60));
        return ok ? { ok: true, message: `${cmd.name}: tick → ${cmd.minutes}m` } : { ok: false, message: `no active peer ${cmd.name}` };
      }
      case "model": {
        const res = await manager.setPeerModel(String(cmd.name), String(cmd.ref));
        return { ok: res.ok, message: res.message };
      }
      case "kill": {
        const ok = await manager.kill(String(cmd.name));
        return ok ? { ok: true, message: `${cmd.name} killed — session deleted` } : { ok: false, message: `no peer ${cmd.name}` };
      }
      case "stop": {
        if (cmd.name === "all") {
          await manager.stopAll();
          return { ok: true, message: "all peers stopped (sessions retained)" };
        }
        const ok = await manager.stop(String(cmd.name));
        return ok ? { ok: true, message: `${cmd.name} stopped (session retained)` } : { ok: false, message: `no active peer ${cmd.name}` };
      }
      default:
        return { ok: false, message: `unknown action "${cmd.action}"` };
    }
  }

  function startInboxWatcher(ctx: ExtensionContext): void {
    if (inboxTimer) return;
    const dir = inboxDir(ctx.cwd);
    const processed = path.join(dir, "processed");
    const ctlDir = path.join(ctx.cwd, ".pi", "peer-agent", "control");
    const ctlProcessed = path.join(ctlDir, "processed");
    inboxTimer = setInterval(() => {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
          if (files.length > 0) {
            fs.mkdirSync(processed, { recursive: true });
            for (const f of files.slice(0, 10)) {
              const p = path.join(dir, f);
              try {
                const msg = JSON.parse(fs.readFileSync(p, "utf8"));
                manager.deliverInboxFinding(msg);
              } catch {
                /* malformed file — archive it anyway so it can't loop */
              }
              fs.renameSync(p, path.join(processed, f));
            }
          }
        }
        if (fs.existsSync(ctlDir)) {
          const files = fs.readdirSync(ctlDir).filter((f) => f.endsWith(".json"));
          if (files.length > 0) {
            fs.mkdirSync(ctlProcessed, { recursive: true });
            for (const f of files.slice(0, 5)) {
              const p = path.join(ctlDir, f);
              let cmd: any = null;
              try {
                cmd = JSON.parse(fs.readFileSync(p, "utf8"));
              } catch {
                /* malformed */
              }
              fs.renameSync(p, path.join(ctlProcessed, f));
              if (!cmd?.id) continue;
              void applyControl(lastCtx ?? ctx, cmd)
                .then((res) => {
                  appendControlAck(ctx.cwd, { id: cmd.id, action: cmd.action, ...res });
                })
                .catch((err) => {
                  appendControlAck(ctx.cwd, { id: cmd.id, action: cmd.action, ok: false, message: String(err).slice(0, 200) });
                });
            }
          }
        }
      } catch {
        /* watcher must never break the session */
      }
    }, 5000);
  }

  pi.on("session_start", async (_e: unknown, ctx: ExtensionContext) => {
    track(ctx);
    // Am I a peer resumed standalone? Then teach reporting-home, and skip
    // the main-session machinery (a peer must not recover peers).
    peerMode = standalonePeerEntry(ctx);
    if (peerMode) {
      pi.sendMessage(
        {
          customType: "peer-standalone-brief",
          content:
            `You are ${peerMode.name} (${peerMode.role}), a peer of main session ${peerMode.parentSessionId}, resumed STANDALONE in a separate terminal. ` +
            `Your standing task: ${peerMode.task}. You may converse freely here. To push a finding to the main session, write a JSON file to ` +
            `.pi/peer-agent/inbox/<unique-name>.json with fields {"peer": "${peerMode.name}", "priority": "info"|"steering", "body": "<one self-contained paragraph>"}. ` +
            `It is delivered to the main agent within seconds, attributed to you. Do not modify anything else in the repository.`,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }
    startInboxWatcher(ctx);
    // Recover this session's suspended crew (restart/resume/reload) — peers
    // are part of the session and come back with it, memory intact.
    try {
      const n = await manager.recover(ctx);
      if (n > 0) ctx.ui?.notify?.(`${n} peer${n > 1 ? "s" : ""} recovered — watch continues`, "info");
    } catch {
      /* recovery must never block session start */
    }
  });
  pi.on("turn_start", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("turn_end", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("session_shutdown", async () => {
    // Close the panel FIRST — a stale overlay surviving /reload would keep
    // rendering from a dead manager ("no peer selected" beside live peers).
    try {
      sidecar?.close();
    } catch {
      /* already gone */
    }
    sidecar = null;
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = null;
    }
    if (peerMode) return; // a standalone peer owns no crew
    // Suspend, don't stop: the crew is part of the session and recovers
    // with it (roster.json keeps them as 'suspended').
    await manager.suspendAll();
  });
}
