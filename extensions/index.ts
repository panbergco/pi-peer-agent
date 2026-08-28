/** pi-peer-agent — extension entry (spec docs/peer-agent-spec.md).
 *
 * Resident peer agents: standing objectives on a seconds-tick, real resumable
 * pi sessions, findings pushed into the main session at inference boundaries
 * (the delivery contract). Pi-native surfaces only: registered tools,
 * slash commands, a shortcut, and an overlay sidecar — no MCP, no tmux, no
 * child processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adhocRole, discoverRoles, parseTick, rhythmOf, roleErrors, roleLine, roleSummary } from "../src/roles.js";
import { chordFamily } from "../src/keychord.js";
import { PeerManager } from "../src/runtime.js";
import { PeerSidecar, adoptHostKeybindings } from "../src/sidecar.js";
import { AUTHORITY_TOOLS, shortId } from "../src/types.js";
import type { Authority } from "../src/types.js";
import { judge, loadRules, refusalText } from "../src/talkrules.js";
import { appendEvent, isOrphaned, loadConfig, markMainStopped, readRoster, registerMain, resetEventSink, setEventEmitter, setEventSink, touchMain, upsertAgentsBlock, type PeerEvent } from "../src/state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function piPeerAgent(pi: ExtensionAPI) {
  const config = loadConfig();
  const manager = new PeerManager(pi, config);
  let lastCtx: ExtensionContext | null = null;
  let sidecar: { component: PeerSidecar; handle: any; tui?: any; close: () => void } | null = null;
  /** Per-agent input survives Tab switches and panel close/reopen. This belongs
   * to the extension lifecycle, not the disposable panel component. */
  const panelDrafts = new Map<string, string>();
  /** Last focus state the panel was deliberately put into (open-with-focus, the
   *  focus chord, Esc/ctrl+c back to the prompt) — see savePanelState. */
  let lastPanelFocused = false;

  // ── panel state memory ───────────────────────────────────────────────────
  // A session that is resumed comes back to the panel it left: open or closed,
  // focused or passive, the same agent selected, the same height, the same
  // half-written messages (operator 2026-08-07: "when panels were open and there
  // was a resume/restart, that state should be remembered exactly").
  //
  // Keyed by the session FILE, not the session id: pi gives a resumed session a NEW
  // id while keeping the same file (measured), so an id key would lose the panel on
  // exactly the restart this exists for. Two different sessions in one project have
  // different files, so they still never restore each other's panel.
  interface PanelState {
    open: boolean;
    focused: boolean;
    selected: string | null;
    heightPct: number | null;
    drafts: Record<string, string>;
    savedAt: string;
  }
  const panelStatePath = (cwd: string) => path.join(cwd, ".pi", "peer-agent", "panel-state.json");
  function readPanelStates(cwd: string): Record<string, PanelState> {
    try {
      return JSON.parse(fs.readFileSync(panelStatePath(cwd), "utf8"));
    } catch {
      return {};
    }
  }
  /** Persist off the frame. Closing the panel used to write the state file twice on the
   *  UI path (once from the component's dispose, once from the toggle); nothing about the
   *  operator's next keystroke depends on that write having landed. Coalesced to one
   *  write per turn of the event loop. */
  let saveQueued = false;
  function savePanelStateSoon(ctx: ExtensionContext): void {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(() => {
      saveQueued = false;
      savePanelState(ctx);
    }, 0);
  }

  function savePanelState(ctx: ExtensionContext): void {
    try {
      const id = (ctx as any)?.sessionManager?.getSessionFile?.();
      if (!id || peerMode) return; // a standalone peer owns no panel
      // Ask the live widget while it is alive and remember the answer; at shutdown
      // the panel has usually released focus already, so the remembered value is
      // what survives. (Saving the shutdown-time answer persisted "focused: false"
      // for a panel the operator left focused.)
      if (sidecar) {
        const live = typeof sidecar.component?.focused === "boolean" ? sidecar.component.focused : sidecar.handle?.isFocused?.();
        if (typeof live === "boolean") lastPanelFocused = live;
      }
      const focused = Boolean(sidecar) && lastPanelFocused;
      const state: PanelState = {
        open: Boolean(sidecar),
        focused,
        selected: lastSelectedPeer,
        heightPct: panelRatio === null ? null : Math.round(panelRatio * 100),
        drafts: Object.fromEntries([...panelDrafts.entries()].filter(([, v]) => v.trim().length > 0)),
        savedAt: new Date().toISOString(),
      };
      const all = readPanelStates(ctx.cwd);
      all[id] = state;
      // Keep the file small: only the 20 most recently saved sessions.
      const trimmed = Object.fromEntries(
        Object.entries(all).sort((a, b) => String(b[1]?.savedAt ?? "").localeCompare(String(a[1]?.savedAt ?? ""))).slice(0, 20),
      );
      fs.mkdirSync(path.dirname(panelStatePath(ctx.cwd)), { recursive: true });
      fs.writeFileSync(panelStatePath(ctx.cwd), JSON.stringify(trimmed, null, 2) + "\n");
      // Half-written messages live in here. Nobody else on this machine needs them.
      try {
        fs.chmodSync(panelStatePath(ctx.cwd), 0o600);
      } catch {
        /* best effort */
      }
    } catch {
      /* panel memory is a convenience: never break a session over it */
    }
  }
  async function restorePanelState(ctx: ExtensionContext): Promise<void> {
    try {
      const id = (ctx as any)?.sessionManager?.getSessionFile?.();
      const state = id ? readPanelStates(ctx.cwd)[id] : undefined;
      if (!state) return;
      if (state.heightPct) panelRatio = Math.min(0.9, Math.max(0.2, state.heightPct / 100));
      if (state.selected) lastSelectedPeer = state.selected;
      for (const [name, text] of Object.entries(state.drafts ?? {})) panelDrafts.set(name, text);
      appendEvent(ctx.cwd, "panel.state-restored", { session: String(id).split("/").pop(), open: state.open, focused: state.focused, selected: state.selected, heightPct: state.heightPct, drafts: Object.keys(state.drafts ?? {}).length });
      if (state.open) await openSidecar(ctx, { focus: state.focused });
    } catch {
      /* a session must start even if its remembered panel cannot be rebuilt */
    }
  }
  // Live panel-height override (operator 2026-08-06: "ctrl alt up and down for
  // smaller and bigger"). Session state layered over panelHeightRatio config —
  // the config file is never rewritten.
  let panelRatio: number | null = null;
  function resizePanel(delta: 1 | -1): number {
    const base = panelRatio ?? config.panelHeightRatio ?? 0.72;
    panelRatio = Math.min(0.9, Math.max(0.2, Math.round((base + delta * 0.1) * 10) / 10));
    sidecar?.tui?.requestRender?.();
    return panelRatio;
  }
  // Which agent the human last addressed. Outlives the panel component so
  // reopening returns to that conversation with its unfinished text.
  let lastSelectedPeer: string | null = null;

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
      savePanelStateSoon(ctx);
      return;
    }
    lastPanelFocused = focus;
    void openSidecar(ctx, { focus }).then(() => savePanelStateSoon(ctx));
  }

  /** ctrl+alt+p = SHOW/HIDE toggle. Opening makes the panel ACTIVE (operator
   *  ruling 2026-08-05, restoring the original behaviour); set
   *  `focusOnOpen: false` in peer-agent.json for a passive view. Esc closes;
   *  the focus key hands the keyboard back without closing. */
  /** Resolve a launch request to a role. A role name is OPTIONAL: when the
   *  given name is not a known role, it is folded back into the instruction and
   *  a role is written on the fly from it (operator 2026-08-06), so
   *  `launch watch the tests for flakes` works with no role at all. */
  function resolveRole(cwd: string, roleName: string | undefined, task: string, opts?: { kind?: any; authority?: Authority }): { role: any; task: string } {
    const roles = discoverRoles(cwd);
    const known = roleName ? roles.find((r) => r.name === roleName) : undefined;
    if (known) return { role: known, task };
    // A role file that EXISTS but could not be read must not be quietly folded into an
    // ad-hoc watcher: asking for `builder-once` and silently getting a nameless watcher is
    // the worst possible answer. Refuse, and say what is wrong with the file.
    const broken = roleName ? roleErrors.find((e) => e.name === roleName) : undefined;
    if (broken) throw new Error(`${roleName} could not be loaded — ${broken.message}`);
    const instruction = [roleName, task].filter(Boolean).join(" ").trim();
    // An ad-hoc contract inherits the launch's own kind and authority, so a launch
    // without a role file is not silently demoted to a read-only watcher.
    return { role: adhocRole(instruction, opts), task: instruction };
  }

  function shortcutToggle(ctx: ExtensionContext): void {
    toggleSidecar(ctx, config.focusOnOpen !== false);
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
    const tickAnswer = role.kind === "task"
      ? ""   // a task never ticks; asking for an interval would promise one
      : await ui.input(`Tick interval in minutes (role default ${Math.round(role.tick / 60)})`, String(Math.round(role.tick / 60)));
    const tickMin = Number.parseInt(tickAnswer ?? "", 10);
    const effRole = Number.isFinite(tickMin) && tickMin >= 1 ? { ...role, tick: tickMin * 60 } : role;
    const peer = await manager.launch(ctx, effRole, task, mode);
    ui.notify?.(`${peer.name} launched (${peer.contextMode}, ${rhythmOf(peer)})`, "info");
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



  /** Render the panel as a WIDGET instead of an overlay.
   *
   *  Overlays make pi relayout the screen the moment one exists: a bare 3-row
   *  probe overlay from an unrelated extension moves pi's footer by 12 lines,
   *  identically for top/bottom anchors and for a 40-row overlay. That is the
   *  "opening peers looks like the transcript is scrolling" the operator kept
   *  reporting, and no overlay option avoids it. A widget renders above the
   *  editor with the footer UNMOVED and only its own lines changing.
   *
   *  Widgets have no focus of their own, so keyboard capture is done with
   *  ctx.ui.onTerminalInput while focused, consuming what the panel handles and
   *  passing everything else through untouched. */
  /** Build the panel component. Shared by both renderers so a widget-rendered
   *  panel and an overlay-rendered one can never drift apart. */
  function buildSidecar(
    ctx: ExtensionContext,
    tui: any,
    theme: any,
    hooks: { onClose: () => void; onUnfocus: () => void },
    kb?: any,
  ): PeerSidecar {
    return new PeerSidecar({
      tui,
      theme,
      keybindings: kb ?? { matches: () => false },
      getPeers: () => manager.all.filter((p) => p.status !== "done" && p.status !== "stopped"),
      getRoles: () => discoverRoles(ctx.cwd),
      // Crop headroom: render 3 rows under the overlay budget so the
      // bottom border always paints (verified by screenshot loop).
      getMaxRows: () => Math.max(8, Math.floor(((Number(tui?.terminal?.rows) || 40) - 6) * (panelRatio ?? config.panelHeightRatio ?? 0.72))),
      onResize: (delta: 1 | -1) => { const r = resizePanel(delta); savePanelStateSoon(ctx); return r; },
      onResizeSet: (pct: number) => {
        panelRatio = Math.min(0.9, Math.max(0.2, pct / 100));
        sidecar?.tui?.requestRender?.();
        savePanelStateSoon(ctx);
        return Math.round(panelRatio * 100);
      },
      resizeUpKeys: resizeUp,
      resizeDownKeys: resizeDown,
      getPanelPct: () => Math.round((panelRatio ?? config.panelHeightRatio ?? 0.72) * 100),
      getModels: () => manager.listModels(),
      lastSelected: () => lastSelectedPeer,
      onSelected: (name: string | null) => { lastSelectedPeer = name; savePanelStateSoon(ctx); },
      onAuthority: (name: string, level: string) => {
        void manager.setAuthority(name, level as any).then((r) => {
          (lastCtx ?? ctx).ui?.notify?.(r.message, r.ok ? "info" : "error");
          sidecar?.tui?.requestRender?.();
        });
      },
      toggleKey: config.toggleKey,
      focusKey: config.focusKey,
      focusAliases: config.focusAliases,
      onUnmatchedKey: (hex: string) => {
        // Ledgered, deduped by the runtime's own event stream: lets a
        // "the key does nothing" report be answered from state.
        appendEvent(ctx.cwd, "panel.unmatched-key", {
    hex,
    toggleKey: config.toggleKey,
    focusKey: config.focusKey,
        });
      },
      getForeignAgents: () => {
        // MAIN sessions never appear in the panel (operator ruling
        // 2026-08-05: "the main should never show up in the panel, it's
        // confusing"). They stay fully discoverable in `pi-peer census`,
        // which is where a session-level view belongs.
        const mine = new Set(manager.all.map((p) => p.name));
        const roster = readRoster(ctx.cwd);
        return roster
    .filter((r) => r.kind !== "main" && !mine.has(r.name))
    .map((r) => ({
      name: r.name,
      role: r.role,
      status: r.status,
      mode: r.mode,
      project: r.project,
      owner: r.parentSessionId ? shortId(r.parentSessionId) : undefined,
      // Named, not disguised: an agent whose owning session is gone is not
      // "in another session" — nothing ticks it (operator 2026-08-06).
      orphaned: isOrphaned(r, roster),
      elsewhere: Boolean(r.project && path.resolve(r.project) !== path.resolve(ctx.cwd)),
    }));
      },
      onTick: (name: string, minutes: number) => {
        if (manager.setTick(name, minutes * 60)) (lastCtx ?? ctx).ui?.notify?.(`${name}: tick → ${minutes}m`, "info");
      },
      onClose: () => hooks.onClose(),
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
        const resolved = resolveRole(ctx.cwd, roleName, task);
        const role = resolved.role;
        task = resolved.task;
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
      onAsk: (name: string, text: string) => {
        void manager.ask(name, text, "operator").then((res) => {
    if (res.status !== "ok") (lastCtx ?? ctx).ui?.notify?.(`${name}: ${res.status}`, "warning");
    tui.requestRender();
        });
      },
      onModel: (name: string, model: string, done?: (error?: string) => void) => {
        void manager.setPeerModel(name, model).then((res) => {
          done?.(res.ok ? undefined : res.message);
          tui.requestRender();
        });
      },
      onRetask: (name: string, task: string) => {
        // The panel reported success unconditionally, so a refusal by a rule looked like a
        // change that had happened.
        const rt = manager.retaskWithReason(name, task);
        (lastCtx ?? ctx).ui?.notify?.(rt.ok ? `${name} retasked` : (rt.why ?? "retask refused"), rt.ok ? "info" : "error");
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
      drafts: panelDrafts,
      onDraftsChanged: () => savePanelStateSoon(ctx),
    });
  }

  /** The widget factory gets no keybinding argument, so the host's manager is
   *  captured once through a zero-size one-frame custom component — the only
   *  surface where pi injects it — and adopted for the panel's editor. */
  let hostKeybindings: any = null;
  async function captureHostKeybindings(ctx: ExtensionContext): Promise<any> {
    if (hostKeybindings) return hostKeybindings;
    try {
      await (ctx.ui as any)?.custom?.(
        (_tui: any, _theme: any, kb: any, done: (r: void) => void) => {
          hostKeybindings = kb;
          queueMicrotask(() => done(undefined));
          return { render: () => [], handleInput: () => {} } as any;
        },
        { overlayOptions: () => ({ anchor: "top-center", width: 1, maxHeight: 1, nonCapturing: true }) },
      );
    } catch {
      /* the panel still works on defaults if the host refuses */
    }
    return hostKeybindings;
  }

  async function openSidecarWidget(ctx: ExtensionContext, opts?: { focus?: boolean }): Promise<void> {
    if (!ctx.hasUI || sidecar) return;
    const ui: any = ctx.ui;
    if (typeof ui.setWidget !== "function") {
      await openSidecarOverlay(ctx, opts);
      return;
    }
    const kb = await captureHostKeybindings(ctx);
    adoptHostKeybindings(kb);
    let unhook: (() => void) | null = null;
    let component: PeerSidecar | null = null;
    let tuiRef: any = null;

    const setFocused = (on: boolean) => {
      if (!component) return;
      component.focused = on;
      if (on && !unhook) {
        unhook = ui.onTerminalInput?.((data: string) => {
          if (!component) return undefined;
          const handled = component.handleInputExternally(data);
          // A widget is not driven by the focus system, so nothing repaints it
          // for us: ask for a frame whenever we consumed a key, or the typing
          // lands in the component and is never drawn.
          if (handled) tuiRef?.requestRender?.();
          return handled ? { consume: true } : undefined;
        }) ?? null;
      } else if (!on && unhook) {
        unhook();
        unhook = null;
      }
      tuiRef?.requestRender?.();
    };

    const close = () => {
      try {
        unhook?.();
      } catch {
        /* already gone */
      }
      unhook = null;
      try {
        ui.setWidget("pi-peer-agent", undefined);
      } catch {
        /* best effort */
      }
      try {
        component?.dispose();
      } catch {
        /* best effort */
      }
      component = null;
      sidecar = null;
      manager.onUpdate = null;
    };

    const placement = config.placement === "aboveEditor" ? "aboveEditor" : "belowEditor";
    ui.setWidget("pi-peer-agent", (tui: any, theme: any) => {
      tuiRef = tui;
      component = buildSidecar(ctx, tui, theme, {
        onClose: () => close(),
        onUnfocus: () => setFocused(false),
      }, kb);
      return component as any;
    }, { placement });
    sidecar = {
      component: component as any,
      handle: { focus: () => setFocused(true), unfocus: () => setFocused(false), isFocused: () => Boolean(component?.focused) },
      tui: tuiRef,
      close,
    };
    manager.onUpdate = () => tuiRef?.requestRender?.();
    if (opts?.focus) setFocused(true);
  }

  async function openSidecar(ctx: ExtensionContext, opts?: { focus?: boolean }): Promise<void> {
    if (config.render !== "overlay") return openSidecarWidget(ctx, opts);
    return openSidecarOverlay(ctx, opts);
  }

  async function openSidecarOverlay(ctx: ExtensionContext, opts?: { focus?: boolean }): Promise<void> {
    let overlayTui: any = null;
    // 1 Hz countdown refresh while the panel is open — cheap under pi's
    // differential renderer, keeps `next Ns` live without streaming churn.
    let countdown: ReturnType<typeof setInterval> | null = null;
    try {
      await (ctx.ui as any).custom(
        (tui: any, theme: any, kb: any, done: (r: void) => void) => {
          overlayTui = tui;
          adoptHostKeybindings(kb);
          const component = buildSidecar(ctx, tui, theme, { onClose: () => done(undefined), onUnfocus: () => sidecar?.handle?.unfocus?.() }, kb);
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
              // must appear without waiting for a local event.
              "#" + readRoster(ctx.cwd).map((r) => `${r.name}:${r.status}`).join(",");
            if (sig !== lastSig) {
              lastSig = sig;
              tui.requestRender();
            }
          }, 1000);
          sidecar = {
            component,
            handle: null,
            tui,
            // Hand the keyboard back BEFORE tearing the overlay down. Without
            // this, closing a panel that held focus left the session with no
            // focused editor at all -- and therefore no visible cursor, which
            // reads exactly like "focus switching stopped working" (found by
            // the focus screenshot drill, 2026-08-05).
            close: () => {
              try {
                // A closing panel is not focused. Clear the flag BEFORE the
                // overlay is torn down: the component can linger in the TUI's
                // overlay stack for a frame or two, and anything reading focus
                // in that window (pi itself, or an extension) would otherwise
                // see a panel that is already gone still claiming the keyboard.
                if (sidecar) sidecar.component.focused = false;
                sidecar?.handle?.unfocus?.();
              } catch {
                /* closing must never throw */
              }
              done(undefined);
            },
          };
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
      try {
        sidecar?.handle?.unfocus?.();
      } catch {
        /* the overlay may already be gone */
      }
      const tuiRef = sidecar?.tui ?? overlayTui;
      if (sidecar) sidecar.component.focused = false;
      sidecar?.component.dispose();
      sidecar = null;
      manager.onUpdate = null;
      // Force a repaint of the region the overlay occupied. Without this the
      // panel's top border could stay painted after close -- a stranded
      // "PEERS ·" rule at the top of the screen (operator: "visual artifacts
      // when I launch a peer and open and close"). Two frames, because the
      // first lands while the overlay is still being torn down.
      try {
        tuiRef?.requestRender?.();
        setTimeout(() => {
          try {
            tuiRef?.requestRender?.();
          } catch {
            /* best effort */
          }
        }, 60);
      } catch {
        /* repaint is cosmetic; never throw from teardown */
      }
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
    description: "peers: (bare = toggle sidecar) | launch/ask/retask/tick/model/authority/attach/stop/kill | tell-all | list",
    // Main-editor argument autocomplete — verbs, then roles/callsigns per verb
    // (same UX as pi's own commands; the panel input has its own provider).
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.split(/\s+/);
      const verb = words[0] ?? "";
      const VERBS: Array<[string, string]> = [
        ["launch", "<role> <task…> — the role's contract decides its kind; add --mission or --task to override, --tick <min>, --fork|--compacted|--fresh"],
        ["ask", "<name> <message…> — ask an agent something; its reply lands in the panel"],
        ["retask", "<name> <task…> — give a peer a new standing task"],
        ["tick", "<name> <minutes> — change a peer's tick interval"],
        ["model", "<name> <provider/model|substring> — change a peer's model"],
        ["authority", "[name] [read-only|write|shell] — list or change authority"],
        ["tell-all", "<text…> — say the same thing to every active agent"],
        ["attach", "<name> — adopt an orphaned agent into this session's crew"],
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
          ? roles.map((r) => ({ value: `launch ${r.name}`, label: r.name, description: `${r.description} · ${roleSummary(r).rhythm}` }))
          : null;
      }
      if (verb === "attach" && words.length === 2) {
        // Only orphans can be adopted, so only orphans are offered.
        const cwdNow = lastCtx?.cwd ?? process.cwd();
        const rosterNow = readRoster(cwdNow);
        const mine = new Set(manager.all.map((p) => p.name));
        const orphans = rosterNow.filter((r) => r.kind !== "main" && !mine.has(r.name) && isOrphaned(r, rosterNow) && r.name.startsWith(argPrefix));
        return orphans.length > 0
          ? orphans.map((r) => ({ value: `attach ${r.name}`, label: r.name, description: `${r.role} · its session is gone · adopt it here` }))
          : null;
      }
      if ((verb === "ask" || verb === "retask" || verb === "tick" || verb === "model" || verb === "authority" || verb === "stop" || verb === "kill") && words.length === 2) {
        const names = manager.active.map((p) => ({ name: p.name, desc: `${p.role.name} · ${p.status}` }));
        if (verb === "stop") names.push({ name: "all", desc: "every active peer" });
        const hits = names.filter((n) => n.name.startsWith(argPrefix));
        return hits.length > 0 ? hits.map((n) => ({ value: `${verb} ${n.name}`, label: n.name, description: n.desc })) : null;
      }
      if (verb === "authority" && words.length === 3) {
        const q = words[2] ?? "";
        return (["read-only", "write", "shell"] as Authority[])
          .filter((level) => level.startsWith(q))
          .map((level) => ({ value: `authority ${words[1]} ${level}`, label: level, description: AUTHORITY_TOOLS[level].join(", ") }));
      }
      return null;
    },
    handler: async (args: unknown, ctx: ExtensionContext) => {
      track(ctx);
      const ui: any = ctx.ui;
      const argv = String(args ?? "").trim();
      const [verb, ...rest] = argv.split(/\s+/).filter(Boolean);

      if (!verb) {
        // bare /peers behaves exactly like the toggle key: opening makes the
        // panel active unless focusOnOpen is disabled.
        toggleSidecar(ctx, config.focusOnOpen !== false);
        return;
      }

      if (verb === "list") {
        const roles = discoverRoles(ctx.cwd);
        const lines = [
          `roles: ${roles.map((r) => `${r.name} (${roleLine(r)})`).join("\n       ") || "none found"}`,
          `active: ${manager.active.map((p) => `${p.name}[t${p.tickCount}${p.findings.length ? ` ◆${p.findings.length}` : ""}]`).join(" · ") || "none"}`,
          `usage: /peers (toggle panel) · /peers launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>] · /peers ask|retask|tick|model|authority|stop|kill … · /peers tell-all <text…>`,
        ];
        ui?.notify?.(lines.join("\n"), "info");
        return;
      }

      if (verb === "launch") {
        // --watch <dir> anywhere in the args roots the peer's file tools there.
        const roles = discoverRoles(ctx.cwd);
        let taskWords = rest.slice(1);
        let mode: any;
        let kindOverride: "mission" | "task" | undefined;
        let tickOverride: number | undefined;
        let watchCwd: string | undefined;
        let objective: { kind: "file" | "exit0"; value: string; maxCycles?: number } | undefined;
        let maxCycles = Number.NaN;
        taskWords = taskWords.filter((w, i, arr) => {
          if (w === "--fork" || w === "--compacted" || w === "--fresh") {
            mode = w.slice(2);
            return false;
          }
          // Manual override of the contract's kind (operator 2026-08-08: two ways to
          // launch — by contract, or by hand).
          if (w === "--mission" || w === "--task") {
            kindOverride = w.slice(2) as "mission" | "task";
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
        const brokenRole = roleErrors.find((e) => e.name === rest[0]);
        if (brokenRole) {
          ui?.notify?.(`${rest[0]} could not be loaded — ${brokenRole.message}`, "error");
          return;
        }
        const role = roles.find((r) => r.name === rest[0]) ?? adhocRole(rest.join(" ").trim(), { kind: kindOverride });
        if (!role) {
          const why = roleErrors.length ? ` · a role file could not be read: ${roleErrors.map((x) => x.message).join("; ")}` : "";
          ui?.notify?.(`unknown role "${rest[0]}" — /peers list shows what exists${why}`, "error");
          return;
        }
        let task = taskWords.join(" ");
        if (!task && ui?.input) task = (await ui.input("Standing task for this peer", role.description)) ?? "";
        if (!task) task = role.description || "watch the main agent's work per your charter";
        const effRole = tickOverride ? { ...role, tick: tickOverride } : role;
        const peer = await manager.launch(ctx, effRole, task, mode, undefined, watchCwd, objective, kindOverride);
        ui?.notify?.(
          `${peer.name} launched (${peer.mode}${kindOverride ? " — you asked for this kind" : effRole.kind ? " — its contract says so" : ""}${peer.objective ? ` until ${peer.objective.kind}:${peer.objective.value}` : ""}, ${peer.contextMode}, ${rhythmOf(peer)}${watchCwd ? `, watching ${watchCwd}` : ""})`,
          "info",
        );
        if (!sidecar) void openSidecar(ctx);
        return;
      }

      if (verb === "attach") {
        const target = rest[0];
        if (!target) {
          ui?.notify?.("attach needs the name of an orphaned agent — see the panel or `pi-peer census`", "error");
          return;
        }
        const r = await applyControl(ctx, { action: "attach", name: target });
        ui?.notify?.(r.message, r.ok ? "info" : "error");
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

      if (verb === "ask") {
        const name = rest[0] ?? "";
        const text = rest.slice(1).join(" ");
        if (!text) {
          ui?.notify?.("usage: /peers ask <name> <message…>", "error");
          return;
        }
        const res = await manager.ask(name, text, "operator");
        if (res.status === "refused") ui?.notify?.(res.reply ?? "refused by a rule", "error");
        else if (res.status === "missing") ui?.notify?.(`no active peer named "${name}"`, "error");
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
        const rt = manager.retaskWithReason(name, task);
        if (!rt.ok && rt.why) ui?.notify?.(rt.why, "error");
        else if (rt.ok) ui?.notify?.(`${name} retasked`, "info");
        else ui?.notify?.(`no active peer named "${name}"`, "error");
        return;
      }

      if (verb === "tick") {
        const name = rest[0] ?? "";
        const minutes = Number(rest[1]);
        if (Number.isFinite(minutes) && minutes >= 1 && manager.setTick(name, minutes * 60)) ui?.notify?.(`${name}: tick → ${minutes}m`, "info");
        else ui?.notify?.("usage: /peers tick <name> <minutes>=1", "error");
        return;
      }

      if (verb === "model") {
        const name = rest[0] ?? "";
        const ref = rest.slice(1).join(" ");
        if (!name || !ref) {
          ui?.notify?.("usage: /peers model <name> <provider/model|substring>", "error");
          return;
        }
        const res = await manager.setPeerModel(name, ref);
        ui?.notify?.(res.message, res.ok ? "info" : "error");
        return;
      }

      if (verb === "authority") {
        const [name, level] = rest;
        if (!name) {
          const rows = manager.all.map((p) => `  ${p.name}  ${p.role.authority ?? "read-only"}`);
          ui?.notify?.(rows.length ? `authority levels:\n${rows.join("\n")}\n  change with: /peers authority <name> <read-only|write|shell>` : "no agents running", "info");
          return;
        }
        if (!level || !["read-only", "write", "shell"].includes(level)) {
          ui?.notify?.(`usage: /peers authority ${name} <read-only|write|shell>`, "error");
          return;
        }
        const res = await manager.setAuthority(name, level as Authority);
        ui?.notify?.(res.message, res.ok ? "info" : "error");
        return;
      }

      if (verb === "tell-all") {
        const n = manager.tellAll(rest.join(" "));
        ui?.notify?.(`told ${n} agent${n === 1 ? "" : "s"}`, "info");
        return;
      }

      ui?.notify?.(`unknown verb "${verb}" — /peers list for usage`, "error");
    },
  });

  // Register the configured chord AND its cross-platform sibling: on macOS the
  // terminal reports ⌘⌥P only when the kitty keyboard protocol negotiated, and
  // falls back to ctrl+alt bytes when it did not. Registering both means the
  // panel opens in either case instead of the key silently doing nothing.
  for (const chord of chordFamily(config.toggleKey)) {
    pi.registerShortcut(chord as any, {
      description: "peers panel: show/hide",
      handler: (ctx: ExtensionContext) => {
        track(ctx);
        shortcutToggle(ctx);
      },
    });
  }

  // Height chords for the UNFOCUSED case (typing in the main prompt): pi's
  // global shortcut layer. The focused panel matches the same chords itself,
  // because a capturing widget sees raw bytes before this layer does.
  // Several chords per direction: GNOME eats ctrl+alt+arrows at the compositor
  // (workspace switching), so shift+alt siblings ship as defaults too.
  const resizeUp = config.resizeUpKeys ?? ["ctrl+alt+up", "shift+alt+up"];
  const resizeDown = config.resizeDownKeys ?? ["ctrl+alt+down", "shift+alt+down"];
  for (const [chords, delta] of [[resizeUp, 1], [resizeDown, -1]] as const) {
    for (const chord of chords) {
      pi.registerShortcut(chord as any, {
        description: `peers panel: ${delta === 1 ? "bigger" : "smaller"}`,
        handler: (ctx: ExtensionContext) => {
          track(ctx);
          if (sidecar) resizePanel(delta);
        },
      });
    }
  }

  const focusChords = [
    ...new Set([config.focusKey, ...(config.focusAliases ?? [])].flatMap((k) => chordFamily(k))),
  ];
  for (const chord of focusChords) pi.registerShortcut(chord as any, {
    description: "peers panel: move keyboard between panel and main prompt",
    handler: (ctx: ExtensionContext) => {
      track(ctx);
      if (!ctx.hasUI) return;
      if (!sidecar) {
        void openSidecar(ctx, { focus: true }); // the focus key opens focused
        return;
      }
      // TOGGLE, not focus-only. Whichever layer receives the chord must produce
      // the same result: pi's global shortcut layer and the panel's own matcher
      // accept different encoding sets, so in some terminals this handler gets
      // the key INSTEAD of the panel. When it only ever focused, pressing the
      // key while the panel was already focused did nothing at all -- exactly
      // the "ctrl+alt+l does not work" report (2026-08-06).
      const focusedNow = sidecar.handle?.isFocused?.() ?? sidecar.component.focused;
      lastPanelFocused = !focusedNow;
      if (focusedNow) {
        try {
          sidecar.handle?.unfocus?.();
        } catch {
          /* releasing focus must never throw */
        }
        sidecar.component.focused = false;
      } else if (sidecar.handle) {
        sidecar.handle.focus();
        sidecar.component.focused = true;
      }
      sidecar.tui?.requestRender?.();
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
      task: Type.String({ description: "The standing task, e.g. 'watch for scope creep vs the goal'." }),
      context: Type.Optional(Type.String({ description: "fork | compacted | fresh (default: role's choice)" })),
      tickMinutes: Type.Optional(Type.Number({ description: "Override this peer's tick interval in MINUTES (min 1). Each peer has its own. The framework issues ticks; the peer itself can never change this." })),
      cwd: Type.Optional(Type.String({ description: "Watch directory: root the peer's read-only file tools at this path (e.g. an executor worktree) instead of the project root." })),
      skills: Type.Optional(Type.String({ description: "Comma-separated skill names this agent should carry, resolved through pi's own skill discovery. An unknown name refuses the launch." })),
      fallback: Type.Optional(Type.String({ description: "Comma-separated models to fall back to, in order, when a turn fails at the provider (rate limit, overload, a path that refuses this agent)." })),
      gate: Type.Optional(Type.String({ description: "TASK kind: an acceptance command the FRAMEWORK runs after the task hands off. The task cannot retire as accepted until it exits 0; a failure is handed back and the task keeps working." })),
      worktree: Type.Optional(Type.Boolean({ description: "Give this agent a separate git checkout. OFF by default and refused unless the project config opts in: agents normally share the worktree and serialize writes on the project lock." })),
      authority: Type.Optional(Type.String({ description: "Human grant at launch: read-only (default), write, or shell. Required for a TASK that must change files, since a task's authority cannot be raised mid-engagement. Refused above a role's ceiling." })),
      kind: Type.Optional(Type.String({ description: "\"mission\" for a ticked worker that advances its own charge until you stop it. TASK kind: pass \"task\" for one engagement that runs to completion, hands off, and retires (no ticks). Omit for a ticked watch." })),
      untilFile: Type.Optional(Type.String({ description: "GOAL mode: work in cycles until this file exists, then report DONE with evidence and retire. Framework-evaluated." })),
      untilExit0: Type.Optional(Type.String({ description: "GOAL mode: work in cycles until this shell command exits 0. Framework-evaluated, never self-asserted." })),
      maxCycles: Type.Optional(Type.Number({ description: "GOAL mode: give up after this many cycles (default 20)." })),
    }),
    async execute(_id: string, params: any, _signal: unknown, _u: unknown, ctx: any) {
      track(ctx);
      let { role, task: resolvedTask } = resolveRole(ctx.cwd, params.role, params.task ?? "");
      if (params.tickMinutes) role = { ...role, tick: Math.max(60, Math.floor(params.tickMinutes * 60)) };
      // Goal params are declared in this tool's schema, so they must reach
      // the manager: passing only 4 of 7 arguments silently downgraded every
      // tool-launched GOAL to an unbounded watch, and dropped per-peer cwd.
      // Mirrors the control-plane path below.
      const objective = params.untilFile
        ? { kind: "file" as const, value: String(params.untilFile), maxCycles: params.maxCycles }
        : params.untilExit0
          ? { kind: "exit0" as const, value: String(params.untilExit0), maxCycles: params.maxCycles }
          : undefined;
      const peer = await manager.launch(
        ctx,
        role,
        resolvedTask,
        params.context,
        undefined,
        params.cwd ? path.resolve(ctx.cwd, String(params.cwd)) : undefined,
        objective,
      );
      return {
        content: [{
          type: "text" as const,
          text: `Peer ${peer.name} launched: ${peer.address}\nsession ${peer.sessionId} (resume: pi --session ${peer.sessionFile})\n${roleLine(role)}`,
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
              `tick: ${rhythmOf(p)} · completed ${p.tickCount} · next in ~${etaS >= 90 ? Math.ceil(etaS / 60) + "m" : etaS + "s"} · quiet streak ${p.quietStreak}`,
              `usage: ${p.usage.input} in · ${p.usage.output} out · $${p.usage.costUsd.toFixed(4)}`,
              p.mode === "mission"
                ? `mode: MISSION · works its charge ${rhythmOf(p)} · ${p.status}`
                : p.mode === "task"
                ? `mode: TASK · one engagement · ${p.status}${p.gate ? ` · gate ${p.gatePassed ? "passed" : `NOT passed (${p.gateAttempts ?? 0} attempts)`}: ${p.gate}` : ""}${p.handoff ? `\n  handoff : ${p.handoff.summary}` : ""}`
                : p.mode === "goal"
                ? `mode: GOAL · condition ${p.objective?.kind}:${p.objective?.value} · cycles ${p.cycles}/${p.objective?.maxCycles ?? 20} · ${p.status}`
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
        .map((r) => `- ${r.name}: ${r.description}\n  ${roleLine(r)}`)
        .join("\n");
      // CENSUS: every agent AND every main session this project knows about —
      // live, ended, or from a previous run. A main is now as findable as its
      // peers (operator finding 2026-08-05: the owner was invisible).
      const live = manager.all;
      const liveNames = new Set(live.map((p) => p.name));
      const rosterAll = readRoster(ctx.cwd);
      const mainLines = rosterAll
        .filter((r) => r.kind === "main")
        .map(
          (m) =>
            `- ${m.name} [MAIN] · ${m.status === "stopped" ? "stopped" : "running"} · last seen ${m.lastSeenAt ?? "?"} · ${m.address} · resume: pi --session ${m.peerSessionFile}`,
        );
      const census = [
        ...mainLines,
        ...live.map(
          (p) =>
            `- ${p.name} [${p.mode}] (${p.role.name}) · ${p.status} · ${p.mode === "goal" ? `cycles ${p.cycles}/${p.objective?.maxCycles ?? 20} until ${p.objective?.kind}:${p.objective?.value}` : `tick ${p.tickCount}`} · findings ${p.findings.length} · $${p.usage.costUsd.toFixed(3)} · task: ${p.task}`,
        ),
        ...rosterAll
          .filter((r) => r.kind !== "main" && !liveNames.has(r.name))
          .map(
            (r) =>
              `- ${r.name} [${r.mode ?? "watch"}] (${r.role}) · ${r.status} (from durable state) · task: ${r.task} · resume: pi --session ${r.peerSessionFile}`,
          ),
      ].join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `ROLES:\n${roles || "(none)"}\n\nAGENT CENSUS — main sessions and every agent launched through this surface (peer_roster with name for full detail):\n${census || "(none)"}`,
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
    name: "peer_ask",
    label: "Ask an agent",
    description:
      "Ask one of your agents something and get its answer. They are long-running " +
      "monitors bound to this session — consult them like colleagues: ask the observer-watch what happened, " +
      "ask the auditor to double-check a claim, ask a sentinel for its current read. The exchange is " +
      "recorded in the peer's own session.",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. sentinel-1 (see peer_roster)." }),
      message: Type.String({ description: "Your message or question to the peer." }),
    }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const res = await manager.ask(params.name, params.message, "main-agent");
      if (res.status === "refused") return { content: [{ type: "text" as const, text: res.reply ?? "refused by a rule" }], details: {} };
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
      const rt = manager.retaskWithReason(params.name, params.task);
      const ok = rt.ok;
      if (!ok && rt.why) return { content: [{ type: "text" as const, text: rt.why }], details: {} };
      if (ok && params.tickMinutes) manager.setTick(params.name, Math.floor(params.tickMinutes * 60));
      return { content: [{ type: "text" as const, text: ok ? `${params.name} retasked${params.tickMinutes ? ` (tick → ${params.tickMinutes}m)` : ""}.` : `No active peer named ${params.name}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_tick",
    label: "Peer tick",
    description: "Change a running peer's tick interval in minutes.",
    parameters: Type.Object({
      name: Type.String({ description: "Peer callsign, e.g. observer-watch-1" }),
      minutes: Type.Number({ description: "Tick interval in minutes (min 1)" }),
    }),
    async execute(_id: string, params: any) {
      const minutes = Number(params.minutes);
      const ok = Number.isFinite(minutes) && minutes >= 1 && manager.setTick(params.name, Math.floor(minutes * 60));
      return { content: [{ type: "text" as const, text: ok ? `${params.name}: tick → ${minutes}m.` : `No active peer named ${params.name}, or minutes is below 1.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_tell_all",
    label: "Tell every agent",
    description: "Say the same thing to every active agent in this project.",
    parameters: Type.Object({ text: Type.String({ description: "What to say to every agent." }) }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const n = manager.tellAll(params.text);
      return { content: [{ type: "text" as const, text: `Told ${n} peer${n === 1 ? "" : "s"}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "peer_kill",
    label: "Kill peer",
    description: "Stop a peer and permanently delete its session file.",
    parameters: Type.Object({ name: Type.String({ description: "Peer callsign." }) }),
    async execute(_id: string, params: any, _s: unknown, _u: unknown, ctx: any) {
      track(ctx);
      const ok = await manager.kill(params.name);
      return { content: [{ type: "text" as const, text: ok ? `${params.name} killed (session deleted).` : `No peer named ${params.name}.` }], details: {} };
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
      // CRITICAL: mains and peers share one roster table. A main
      // session must never match its OWN main-kind entry here -- that made a
      // main session brief itself as a peer-of-nothing on every resume
      // (operator-reported regression 2026-08-05: "You are main-<id> (main),
      // a peer of main session ," -- the empty parent is the tell). Only a
      // "peer" kind entry means this session IS a peer.
      return readRoster(ctx.cwd).find((e) => e.peerSessionId === sid && e.kind !== "main") ?? null;
    } catch {
      return null;
    }
  }

  function appendControlAck(cwd: string, payload: Record<string, unknown>): void {
    appendEvent(cwd, "control.applied", payload);
    // Also leave the answer BESIDE the request. A caller in another project reads the
    // ledger of ITS OWN project, so an acknowledgement recorded only here would be
    // invisible to whoever asked — which is what made the reply half of a cross-project
    // message impossible.
    try {
      const id = String(payload.id ?? "");
      if (!id) return;
      const dir = path.join(cwd, ".pi", "peer-agent", "control", "processed");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.ack.json`), JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      /* the in-project ledger above is the primary record */
    }
  }

  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let peerMode: any = null; // roster entry when this session IS a peer
  let mainSessionId: string | null = null; // set once this session registers itself
  let healing = false; // guards the crew self-heal from overlapping runs

  function inboxDir(cwd: string): string {
    return path.join(cwd, ".pi", "peer-agent", "inbox");
  }

  /** Apply one CLI control command (from .pi/peer-agent/control/) and ack
   *  through the ledger so `pi-peer` can print the outcome. */
  async function applyControl(ctx: ExtensionContext, cmd: any): Promise<{ ok: boolean; message: string; reply?: string }> {
    switch (cmd.action) {
      case "authority": {
        const res = await manager.setAuthority(String(cmd.name), cmd.level);
        return { ok: res.ok, message: res.message };
      }
      case "wave": {
        // N tasks, one unit, one report. Same role and grant for every member.
        const items = Array.isArray(cmd.items) ? cmd.items as { key: string; task: string }[] : [];
        if (items.length < 2) return { ok: false, message: "a wave needs at least two tasks (use `task` for one)" };
        const keys = items.map((i) => i.key);
        if (new Set(keys).size !== keys.length) return { ok: false, message: `wave keys must be unique (got ${keys.join(", ")})` };
        const resolvedW = resolveRole(ctx.cwd, cmd.role, items.map((i) => i.task).join(" "), {
          kind: "task",
          authority: cmd.authority ? (String(cmd.authority) as Authority) : undefined,
        });
        const roleW = resolvedW.role;
        let grantedW: Authority | undefined;
        if (cmd.authority) {
          const want = String(cmd.authority) as Authority;
          const RANK: Record<Authority, number> = { "read-only": 0, write: 1, shell: 2 };
          if (!["read-only", "write", "shell"].includes(want)) return { ok: false, message: `authority must be read-only, write or shell (got ${want})` };
          const cap: Authority | undefined = roleW.authorityCeiling;
          if (cap && RANK[want] > RANK[cap]) return { ok: false, message: `${roleW.name} cannot be launched at ${want}: its role is capped at ${cap} — advisory by construction.` };
          grantedW = want;
        }
        const effW = grantedW ? { ...roleW, authority: grantedW, tools: AUTHORITY_TOOLS[grantedW] } : roleW;
        const { waveId, peers } = await manager.launchWave(ctx, effW, items, { mode: cmd.context, gate: cmd.gate ? String(cmd.gate) : undefined });
        if (grantedW && grantedW !== "read-only") for (const p of peers) appendEvent(ctx.cwd, "peer.authority", { peer: p.name, from: "read-only", to: grantedW, by: "human", at: "launch" });
        return { ok: true, message: `wave ${shortId(waveId)} launched with ${peers.length} tasks: ${peers.map((p, i) => `${items[i]!.key}=${p.name}`).join(", ")} — you will hear once, when the last one retires` };
      }
      case "launch": {
        // Role optional: an unknown name folds back into the instruction and a
        // role is written on the fly from it.
        const resolved = resolveRole(ctx.cwd, cmd.role, String(cmd.task ?? ""), {
          kind: cmd.kind === "task" ? "task" : cmd.kind === "mission" ? "mission" : undefined,
          authority: cmd.authority ? (String(cmd.authority) as Authority) : undefined,
        });
        const role = resolved.role;
        cmd = { ...cmd, task: resolved.task };
        const eff = cmd.tickMinutes ? { ...role, tick: Math.max(60, Math.floor(cmd.tickMinutes * 60)) } : role;
        const obj = cmd.untilFile
          ? { kind: "file" as const, value: String(cmd.untilFile), maxCycles: cmd.maxCycles }
          : cmd.untilExit0
            ? { kind: "exit0" as const, value: String(cmd.untilExit0), maxCycles: cmd.maxCycles }
            : undefined;
        const kind = cmd.kind === "task" ? ("task" as const) : cmd.kind === "mission" ? ("mission" as const) : undefined;
        // A human may grant authority AT LAUNCH. This is the same explicit human
        // action as the elevation ceremony, moved earlier: a TASK runs its whole
        // engagement immediately, so granting after launch would arrive too late
        // (found while proving the delegation roles, 2026-08-06). A role ceiling
        // still refuses.
        let granted: Authority | undefined;
        if (cmd.authority) {
          const want = String(cmd.authority) as Authority;
          const RANK: Record<Authority, number> = { "read-only": 0, write: 1, shell: 2 };
          if (!["read-only", "write", "shell"].includes(want)) return { ok: false, message: `authority must be read-only, write or shell (got ${want})` };
          const cap: Authority | undefined = role.authorityCeiling;
          if (cap && RANK[want] > RANK[cap]) return { ok: false, message: `${role.name} cannot be launched at ${want}: its role is capped at ${cap} — advisory by construction.` };
          granted = want;
        }
        // Separate checkouts are opt-in only. Default: the shared worktree, with
        // mutations serialized on the project write lock.
        let agentCwd = cmd.watchCwd ? path.resolve(ctx.cwd, String(cmd.watchCwd)) : undefined;
        if (cmd.worktree) {
          if (!config.worktrees) {
            return { ok: false, message: `worktrees are off: agents share this worktree and serialize writes on the project lock. Set "worktrees": true in ~/.pi/agent/peer-agent.json to allow separate checkouts.` };
          }
          const wt = path.join(ctx.cwd, ".pi", "peer-agent", "worktrees", `${role.name}-${Date.now().toString(36)}`);
          const branch = `peer/${role.name}-${Date.now().toString(36)}`;
          const res = spawnSync("git", ["worktree", "add", "-b", branch, wt], { cwd: ctx.cwd, encoding: "utf8" });
          if (res.status !== 0) return { ok: false, message: `worktree creation failed: ${String(res.stderr ?? "").trim().slice(0, 200)}` };
          appendEvent(ctx.cwd, "worktree.created", { role: role.name, path: wt, branch });
          agentCwd = wt;
        }
        // A launch may add or replace the role's fallback chain.
        const sk = typeof cmd.skills === "string" ? String(cmd.skills).split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        const fb = typeof cmd.fallback === "string" ? String(cmd.fallback).split(",").map((m) => m.trim()).filter(Boolean) : undefined;
        const effSk = sk?.length ? { ...eff, skills: sk } : eff;
        const effFb = fb?.length ? { ...effSk, fallbackModels: fb } : effSk;
        const effAuth = granted ? { ...effFb, authority: granted, tools: AUTHORITY_TOOLS[granted] } : effFb;
        const peer = await manager.launch(ctx, effAuth, String(cmd.task ?? role.description), cmd.context, cmd.model ? String(cmd.model) : undefined, agentCwd, obj, kind, cmd.gate ? String(cmd.gate) : undefined);
        if (granted && granted !== "read-only") appendEvent(ctx.cwd, "peer.authority", { peer: peer.name, from: "read-only", to: granted, by: "human", at: "launch" });
        return { ok: true, message: `${peer.name} launched (${peer.mode}${peer.objective ? ` until ${peer.objective.kind}:${peer.objective.value}` : ""}${peer.mode === "task" ? `, one engagement then retires${cmd.gate ? `, accepted only when \`${cmd.gate}\` exits 0` : ""}` : peer.mode === "mission" ? `, working its charge ${rhythmOf(peer)} until you stop it` : `, ${rhythmOf(peer)}`}) · resume: pi --session ${peer.sessionFile}` };
      }
      case "tell-all": {
        const n = manager.tellAll(String(cmd.message ?? ""));
        return { ok: true, message: `told ${n} agent${n === 1 ? "" : "s"}` };
      }
      case "ask": {
        // asking a SESSION: addressed by session id, not a peer callsign.
        // Delivery is injection into the live turn -- like a peer's finding,
        // not a blocking RPC, so there is no "reply" to return synchronously.
        if (cmd.target) {
          // Reaching a SESSION from outside. The rules name who may reach a session, so
          // this door is judged like the others rather than trusted because it arrived on
          // the control channel.
          {
            const attempt = { from: (typeof cmd.from === "string" && cmd.from.startsWith("peer:") ? "peer" : "parent") as "peer" | "parent", fromName: String(cmd.from ?? "the command line"), fromProject: ctx.cwd, to: "parent" as const, toName: String(cmd.target), toProject: ctx.cwd };
            const verdict = judge(attempt, loadRules(ctx.cwd));
            appendEvent(ctx.cwd, "talk.judged", { from: attempt.fromName, to: attempt.toName, direction: `${attempt.from}->parent`, via: "ask-parent", allowed: verdict.allowed, by: verdict.by?.rule ?? null, file: verdict.by?.file ?? null });
            if (!verdict.allowed) return { ok: false, message: refusalText(attempt, verdict) };
          }
          const content = `[main-agent] message from outside agent://pi/${cmd.target} (control, ask)\n\n${String(cmd.message)}`;
          pi.sendMessage({ customType: "main-ask", content, display: true }, { deliverAs: "steer", triggerTurn: true });
          appendEvent(ctx.cwd, "main.ask.delivered", { target: cmd.target, chars: String(cmd.message).length });
          return { ok: true, message: `delivered into the live session's turn (target ${cmd.target}) -- it will respond in its own session, not here` };
        }
        // A control may name its sender. A message that crossed from another project
        // arrives here, and calling it "operator" would erase the agent that actually
        // spoke — the recipient's own transcript is where attribution has to survive.
        const sender = typeof cmd.from === "string" && cmd.from.length > 0 ? (cmd.from as any) : "operator";
        const res = await manager.ask(String(cmd.name), String(cmd.message), sender);
        // A refusal carries WHY. Reporting only the status turned "no rule permits
        // this" into the bare word "refused", which tells the reader nothing they can
        // act on and reads like the agent is simply unavailable.
        if (res.status === "refused") return { ok: false, message: res.reply ?? `${cmd.name}: refused by a rule` };
        if (res.status !== "ok") return { ok: false, message: `${cmd.name}: ${res.status}` };
        return { ok: true, message: `${cmd.name} replied:`, reply: res.reply ?? "(empty)" };
      }
      case "retask": {
        const rt = manager.retaskWithReason(String(cmd.name), String(cmd.task));
        const ok = rt.ok;
        if (!ok && rt.why) return { ok: false, message: rt.why };
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
      case "models": {
        // The shell picker's data source: the SAME list the panel shows
        // (pi's scoped models when configured, else the full registry).
        const q = String(cmd.query ?? "").trim().toLowerCase();
        const models = manager.listModels().filter((m) => !q || m.toLowerCase().includes(q));
        if (models.length === 0) return { ok: false, message: `no model matching "${cmd.query}" among pi's available models` };
        const current = manager.active.map((p) => `${p.name} → ${p.modelLabel}`).join(" · ");
        return { ok: true, message: `${models.length} model(s)${current ? ` · ${current}` : ""}`, reply: models.join("\n") };
      }
      case "kill": {
        const ok = await manager.kill(String(cmd.name));
        return ok ? { ok: true, message: `${cmd.name} killed — session deleted` } : { ok: false, message: `no peer ${cmd.name}` };
      }
      case "roles": {
        const rs = discoverRoles(ctx.cwd);
        const home = process.env.HOME ?? "";
        const short = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
        const lines = rs.map(
          (r) =>
            `  ${r.name.padEnd(20)} ${roleLine(r)}\n` +
            `  ${" ".repeat(20)} ${roleSummary(r).file || "(no file — built from your instruction)"}\n` +
            `  ${" ".repeat(20)} ${r.description}`,
        );
        const broken = roleErrors.length ? `\n\n  could not be read:\n${roleErrors.map((x) => `    ${x.message}`).join("\n")}` : "";
        return {
          ok: true,
          message:
            `ROLES YOU CAN LAUNCH · ${rs.length}\n${lines.join("\n\n")}${broken}\n\n` +
            `  a role file is a template — copy one and edit it:\n` +
            `    ~/.pi/agent/peers/<name>.md      your own roles, every project\n` +
            `    ${path.join(ctx.cwd, ".pi", "peers")}/<name>.md   this project only (wins over the others)`,
        };
      }
      case "attach": {
        // Same verb the CLI uses, same manager path — the panel is not a second
        // implementation.
        const r = await manager.attach(ctx, String(cmd.name ?? ""));
        return r;
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
        // A command this session does not recognise is usually not a typo: it is a newer
        // command line talking to an older running session, which keeps the extension it
        // loaded at startup. Say that, because "unknown action" sends people looking for a
        // bug in the wrong place — it cost two agents an evening.
        return {
          ok: false,
          message:
            `this session does not know the command "${cmd.action}". It loaded pi-peer-agent when it started, ` +
            `so a newer command line can outrun it. Restart this session to pick up the current version: ` +
            `pi --session <this session's file> (pi-peer census prints it).`,
        };
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
              // A control targeted at a DIFFERENT main session (ask-parent,
              // addressed by session id) is not mine to consume -- leave it
              // for the right session's watcher rather than misdeliver or
              // silently drop it. Everything else (peer commands, or a
              // target that matches ME) is handled here as before.
              if (cmd?.action === "ask" && cmd?.target && mainSessionId && cmd.target !== mainSessionId) {
                const mains = readRoster(ctx.cwd).filter((e) => e.kind === "main");
                const targetsAnotherMain = mains.some((m) => m.peerSessionId === cmd.target || m.peerSessionId.startsWith(cmd.target));
                const targetsMe = mainSessionId === cmd.target || mainSessionId.startsWith(cmd.target);
                if (targetsAnotherMain && !targetsMe) continue; // leave the file in place
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
        // Heartbeat: prove this main session's registration is CURRENT, not a
        // stale record left by a session that crashed without shutdown.
        if (mainSessionId) {
          try {
            touchMain(ctx.cwd, mainSessionId);
          } catch {
            /* advisory */
          }
          // SELF-HEAL: peers are suspended on shutdown and revived on the next
          // session_start. If that start never ran, or failed partway (an
          // extension hot-reload, a crashed activation), the crew stays
          // suspended forever while its session is demonstrably alive -- which
          // is exactly what a resident monitor must never do (operator, 23:39:
          // "why has the agent in this session suspended? that is exactly what
          // it should not have to be"). A live heartbeat with suspended agents
          // of our own is a contradiction, so heal it.
          try {
            const live = new Set(manager.all.map((p) => p.name));
            const stranded = readRoster(ctx.cwd).filter(
              (r) =>
                r.kind !== "main" &&
                r.status === "suspended" &&
                r.parentSessionId === mainSessionId &&
                !live.has(r.name),
            );
            if (stranded.length > 0 && !healing) {
              healing = true;
              appendEvent(ctx.cwd, "crew.self-heal", { stranded: stranded.map((r) => r.name) });
              void manager
                .recover(ctx)
                .then((n) => {
                  if (n > 0) ctx.ui?.notify?.(`${n} agent${n > 1 ? "s" : ""} recovered — watch resumed`, "info");
                })
                .finally(() => {
                  healing = false;
                });
            }
          } catch {
            /* self-heal is best effort; never break the heartbeat */
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
    // macOS + a multiplexer: pi's startup kitty-keyboard-protocol query can be
    // dropped while the surface is still attaching, leaving the terminal in
    // legacy mode where ⌘ chords cannot be reported at all. Re-ask shortly
    // after start; harmless when the protocol is already active (the terminal
    // simply re-answers). Credit: PR #1 by @abhishakenp diagnosed this.
    if (process.platform === "darwin") {
      setTimeout(() => {
        try {
          process.stdout.write("\x1b[>7u\x1b[?u\x1b[c");
        } catch {
          /* never break a session over a capability probe */
        }
      }, 1500);
    }
    startInboxWatcher(ctx);
    // Register MYSELF (operator finding 2026-08-05: peers were discoverable,
    // the main session that owns them was not). Best-effort, never fatal.
    try {
      const sid = (ctx as any)?.sessionManager?.getSessionId?.();
      const sfile = (ctx as any)?.sessionManager?.getSessionFile?.();
      if (sid) {
        mainSessionId = sid;
        // Stamp every event this session writes with the project and the session id, so
        // the ledger stops needing to be read positionally — several pi instances share
        // one project's file.
        setEventEmitter(ctx.cwd, sid);
        registerMain(ctx.cwd, { id: sid, file: sfile ?? "", model: (ctx as any)?.model?.id });
        // The transcript path belongs in the record: without it the log could name a
        // session it could not lead you to.
        appendEvent(ctx.cwd, "main.registered", { sessionId: sid, sessionFile: sfile ?? null, cwd: ctx.cwd });
        // Refresh the agent-facing instructions on EVERY start, not only when an agent is
        // launched. They were written once and never revisited, so after a rename every
        // agent in every project kept reading verbs that no longer exist and reported the
        // product as broken — which is what happened.
        upsertAgentsBlock(ctx.cwd);
      }
    } catch {
      /* registration is advisory, never fatal */
    }
    // Recover this session's suspended crew (restart/resume/reload) — peers
    // are part of the session and come back with it, memory intact.
    try {
      const n = await manager.recover(ctx);
      if (n > 0) ctx.ui?.notify?.(`${n} peer${n > 1 ? "s" : ""} recovered — watch continues`, "info");
    } catch {
      /* recovery must never block session start */
    }
    // The panel this session was last looking at comes back with it — after the
    // crew is recovered, so a restored selection points at a live agent.
    await restorePanelState(ctx);
  });
  pi.on("turn_start", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("turn_end", (_e: unknown, ctx: ExtensionContext) => track(ctx));
  pi.on("session_shutdown", async () => {
    // Remember the panel while it still exists — but let it flush its half-written
    // message into the shared draft map first, which it does on dispose. Order
    // matters: saving before the flush persisted an empty draft set.
    try {
      sidecar?.component?.flushDraft?.();
      if (lastCtx) savePanelState(lastCtx); // closed is a state worth remembering too
    } catch {
      /* never block shutdown over panel memory */
    }
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
    if (mainSessionId && lastCtx) {
      try {
        markMainStopped(lastCtx.cwd, mainSessionId);
        appendEvent(lastCtx.cwd, "main.stopped", { sessionId: mainSessionId });
      } catch {
        /* advisory */
      }
    }
  });
}
