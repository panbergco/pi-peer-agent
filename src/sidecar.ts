/** The peers panel — btw-faithful overlay (spec §8).
 *
 * Faithful to pi-btw-sidecar's proven mechanics:
 *  - a REAL embedded pi-tui Editor at the bottom: type to the selected peer,
 *    Enter sends; full editing/paste/cursor UX (rendered unfocused for
 *    geometric stability — btw's trick);
 *  - FIXED dialog height (padded viewport) so the panel never shifts with
 *    background or content;
 *  - follow-tail transcript with maxScroll clamping; wheel + Up/Down/PgUp/PgDn
 *    scroll; Tab cycles peers;
 *  - /commands inside the input (/launch, /stop, /close, /insert, /yank,
 *    /resume, /retask, /help) — no single-letter hotkeys stealing typed text.
 *
 * Frame color is deliberately non-theme: deep purple = "this is an overlay".
 * Bright purple = keys go here; dark purple = your typing goes to the main
 * prompt.
 */

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Peer } from "./runtime.js";
import type { PeerRole } from "./types.js";
import { shortId } from "./types.js";

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

type Theme = { fg(role: string, text: string): string; bold?(text: string): string };

export interface SidecarOptions {
  tui: TUI;
  theme: Theme;
  keybindings: { matches(data: string, id: string): boolean };
  getPeers: () => Peer[];
  getRoles: () => PeerRole[];
  getMaxRows: () => number;
  onClose: () => void;
  onUnfocus: () => void;
  onStop: (name: string) => void;
  /** Kill: stop + delete the peer's session (irreversible). */
  onKill: (name: string) => void;
  /** Interactive launch via dialogs (no-args /launch). */
  onLaunch: () => void;
  /** Direct launch from panel input: /launch <role> <task…>. */
  onLaunchDirect: (role: string, task: string) => void;
  onTalk: (name: string, text: string) => void;
  /** /model [query] — change the selected peer's model (picker when ambiguous). */
  onModel: (name: string, query: string) => void;
  /** Models available in pi — for /model autocomplete. */
  getModels: () => string[];
  /** Change the selected peer's tick interval (minutes). */
  onTick: (name: string, minutes: number) => void;
  /** Agents in this project owned by ANOTHER session (durable state) — shown
   *  read-only so the panel is a complete census, never a partial view. */
  getForeignAgents?: () => Array<{ name: string; role: string; status: string; mode?: string }>;
  onRetask: (name: string, task: string) => void;
  insertText: (text: string) => void;
  yankText: (text: string, label: string) => void;
  requestRender: () => void;
}

const LIST_MAX = 6;

export class PeerSidecar extends Container implements Focusable {
  private readonly input: Editor;
  private selected = 0;
  private scrollOffset = 0;
  private follow = true;
  private viewportHeight = 8;
  private flash = "";
  private flashAt = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    const changed = this._focused !== value;
    this._focused = value;
    (this.input as any).focused = value;
    // Grab the mouse only while we hold the keyboard: an unfocused panel must
    // leave the terminal's own selection/copy alone.
    if (changed) this.setMouseCapture(value);
  }

  constructor(private opts: SidecarOptions) {
    super();
    const editorTheme: EditorTheme = {
      borderColor: (s: string) => this.purple(s),
      selectList: {
        selectedPrefix: (s: string) => this.safeFg("accent", s),
        selectedText: (s: string) => s,
        description: (s: string) => this.safeFg("dim", s),
        scrollInfo: (s: string) => this.safeFg("dim", s),
        noMatch: (s: string) => this.safeFg("dim", s),
      },
    } as EditorTheme;
    this.input = new Editor(opts.tui, editorTheme, { paddingX: 0 });
    (this.input as any).onSubmit = (value: string) => this.submit(value);
    // Slash-command autocomplete — pi's own mechanism (CombinedAutocompleteProvider),
    // with per-argument completions: roles for /launch, models for /model,
    // peer callsigns for /stop and /retask.
    const peerItems = (prefix: string): AutocompleteItem[] =>
      this.opts
        .getPeers()
        .filter((p) => p.name.startsWith(prefix))
        .map((p) => ({ value: p.name, label: p.name, description: `${p.role.name} · ${p.status}` }));
    const commands = [
      {
        name: "launch",
        description: "launch a peer (bare = interactive picker)",
        argumentHint: "[role] [task…]",
        getArgumentCompletions: (prefix: string) =>
          prefix.includes(" ")
            ? null
            : this.opts
                .getRoles()
                .filter((r) => r.name.startsWith(prefix))
                .map((r) => ({ value: r.name, label: r.name, description: `${r.description} · tick ${Math.round(r.tick / 60)}m` })),
      },
      {
        name: "model",
        description: "change the selected peer's model (mirrors pi's registry)",
        argumentHint: "[provider/model]",
        getArgumentCompletions: (prefix: string) => {
          const q = prefix.toLowerCase();
          return this.opts
            .getModels()
            .filter((m) => m.toLowerCase().includes(q))
            .slice(0, 15)
            .map((m) => ({ value: m, label: m }));
        },
      },
      { name: "stop", description: "stop a peer (session retained, resumable)", argumentHint: "[name]", getArgumentCompletions: peerItems },
      { name: "kill", description: "stop AND delete the peer's session (irreversible)", argumentHint: "[name]", getArgumentCompletions: peerItems },
      { name: "tick", description: "change the selected peer's tick interval", argumentHint: "<minutes>" },
      { name: "retask", description: "give the selected peer a new standing task", argumentHint: "<task…>" },
      { name: "insert", description: "insert the latest finding into the main prompt" },
      { name: "yank", description: "copy latest finding (or pane) to clipboard" },
      { name: "resume", description: "copy the standalone resume command" },
      { name: "close", description: "close the panel" },
      { name: "help", description: "list panel commands" },
    ];
    this.input.setAutocompleteProvider(new CombinedAutocompleteProvider(commands as any, process.cwd()));
    // Mouse reporting is enabled only while the panel is FOCUSED (see the
    // focused setter): with it on, the terminal hands us the mouse and the
    // operator cannot select/copy text with the mouse at all.
  }

  /** SGR mouse reporting: on while focused (wheel scrolling), off otherwise so
   *  normal terminal selection/copy works (operator report 2026-08-05). */
  private setMouseCapture(on: boolean): void {
    (this.opts.tui as any).terminal?.write?.(on ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
  }

  dispose(): void {
    this.setMouseCapture(false);
  }

  // ---------------------------------------------------------------- helpers

  private safeFg(role: string, text: string): string {
    try {
      return this.opts.theme.fg(role, text);
    } catch {
      return text;
    }
  }

  private purple(s: string): string {
    return `\x1b[38;5;${this._focused ? 135 : 54}m${s}\x1b[39m`;
  }

  private selectedPeer(): Peer | undefined {
    return this.opts.getPeers()[this.selected];
  }

  private setFlash(text: string): void {
    this.flash = text;
    this.flashAt = Date.now();
    this.opts.requestRender();
  }

  /** External selection (peer_panel tool). */
  selectPeer(name: string): boolean {
    const idx = this.opts.getPeers().findIndex((p) => p.name === name);
    if (idx === -1) return false;
    this.selected = idx;
    this.follow = true;
    this.opts.requestRender();
    return true;
  }

  // ----------------------------------------------------------------- input

  private submit(raw: string): void {
    const value = raw.trim();
    this.input.setText("");
    if (!value) return;
    if (value.startsWith("/")) {
      this.command(value.slice(1));
      return;
    }
    const peer = this.selectedPeer();
    if (!peer) {
      this.setFlash(this.opts.getPeers().length === 0 ? "no peers yet — /launch <role> <task…> starts one" : "no peer selected — Tab to pick one");
      return;
    }
    this.follow = true;
    this.opts.onTalk(peer.name, value);
  }

  private command(cmd: string): void {
    const [verb, ...rest] = cmd.split(/\s+/).filter(Boolean);
    const peer = this.selectedPeer();
    // Muscle memory: "/peers launch x" typed in the panel routes to "/launch x".
    if ((verb ?? "").toLowerCase() === "peers" || (verb ?? "").toLowerCase() === "peer") {
      if (rest.length === 0) {
        this.opts.onClose();
        return;
      }
      this.command(rest.join(" "));
      return;
    }
    switch ((verb ?? "").toLowerCase()) {
      case "help":
        this.setFlash("/launch [role task…] · /model [query] · /tick <min> · /stop [name] · /kill [name] · /retask <task…> · /insert · /yank · /resume · /close");
        return;
      case "model":
        if (peer) this.opts.onModel(peer.name, rest.join(" "));
        else this.setFlash("no peer selected — /launch first");
        return;
      case "tick": {
        const min = Number.parseInt(rest[0] ?? "", 10);
        if (peer && Number.isFinite(min) && min >= 1) this.opts.onTick(peer.name, min);
        else this.setFlash("usage: /tick <minutes>");
        return;
      }
      case "launch":
        if (rest.length >= 2) this.opts.onLaunchDirect(rest[0]!, rest.slice(1).join(" "));
        else this.opts.onLaunch();
        return;
      case "stop": {
        const name = rest[0] ?? peer?.name;
        if (name) this.opts.onStop(name);
        else this.setFlash("no peer to stop");
        return;
      }
      case "kill": {
        const name = rest[0] ?? peer?.name;
        if (name) {
          this.opts.onKill(name);
          this.setFlash(`${name} killed — watch ended, session deleted`);
        } else this.setFlash("no peer to kill");
        return;
      }
      case "retask":
        if (peer && rest.length) this.opts.onRetask(peer.name, rest.join(" "));
        else this.setFlash("usage: /retask <new task…>");
        return;
      case "insert": {
        const f = peer?.findings[peer.findings.length - 1];
        if (f && peer) this.opts.insertText(`Peer ${peer.name} (${peer.role.name}) found [tick ${f.tick}]: ${f.body}`);
        else this.setFlash("no finding to insert");
        return;
      }
      case "yank": {
        const f = peer?.findings[peer.findings.length - 1];
        if (f) this.opts.yankText(f.body, "finding");
        else if (peer) this.opts.yankText(peer.pane.map((e) => e.text).join("\n"), `${peer.name} pane`);
        else this.setFlash("nothing to yank");
        return;
      }
      case "resume":
        if (peer) this.opts.yankText(`pi --session ${peer.sessionFile}`, "resume command");
        else this.setFlash("no peer selected");
        return;
      case "close":
        this.opts.onClose();
        return;
      default:
        this.setFlash(`unknown /${verb ?? ""} — try /help`);
    }
  }

  private mouseDelta(data: string): number | null {
    const m = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!m) return null;
    const btn = Number(m[1]);
    if ((btn & 64) !== 64) return null;
    return (btn & 1) === 0 ? -3 : 3;
  }

  private scrollBy(delta: number): void {
    if (delta < 0) this.follow = false;
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.opts.requestRender();
  }

  /** ctrl+alt+p in legacy (ESC+ctrl-p) or CSI-u encoding. The focused
   *  panel's editor would otherwise swallow the chord, making the global
   *  shortcut unable to close what it opened (btw guards identically). */
  private isToggleChord(data: string): boolean {
    return data === "\x1b\x10" || data === "\x1b[112;7u" || data === "\x1b[80;7u";
  }

  /** ctrl+alt+l — focus toggle chord (legacy ESC+ctrl-l and CSI-u). */
  private isFocusChord(data: string): boolean {
    return data === "\x1b\x0c" || data === "\x1b[108;7u" || data === "\x1b[76;7u";
  }

  handleInput(data: string): void {
    if (this.isToggleChord(data)) {
      this.opts.onClose();
      return;
    }
    if (this.isFocusChord(data)) {
      // Panel receives input only when focused → hand keys back to main.
      this.opts.onUnfocus();
      return;
    }
    const wheel = this.mouseDelta(data);
    if (wheel !== null) {
      this.scrollBy(wheel);
      return;
    }
    // While the autocomplete list is open, ↑↓/Tab/Enter belong to it.
    const acOpen = Boolean((this.input as any).autocompleteState);
    if (!acOpen) {
      if (matchesKey(data, Key.pageUp)) {
        this.scrollBy(-(Math.max(1, this.viewportHeight - 1)));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.scrollBy(Math.max(1, this.viewportHeight - 1));
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.scrollBy(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.scrollBy(1);
        return;
      }
      if (matchesKey(data, Key.tab)) {
        const n = this.opts.getPeers().length;
        if (n > 0) {
          this.selected = (this.selected + 1) % n;
          this.follow = true;
          this.scrollOffset = 0;
          this.opts.requestRender();
        }
        return;
      }
    }
    if (matchesKey(data, Key.escape)) {
      // Esc clears a draft first; on an empty input it CLOSES the panel
      // (operator ruling). Handing keys to main without closing is ctrl+alt+o.
      if (this.input.getText().length > 0) {
        this.input.setText("");
        this.opts.requestRender();
      } else {
        this.opts.onClose();
      }
      return;
    }
    if (this.opts.keybindings.matches(data, "app.clear")) {
      if (this.input.getText().length > 0) {
        this.input.setText("");
        this.opts.requestRender();
        return;
      }
      this.opts.onClose();
      return;
    }
    (this.input as any).handleInput(data);
  }

  // ---------------------------------------------------------------- render

  private frameLine(content: string, inner: number): string {
    const truncated = truncateToWidth(content, inner, "");
    const pad = Math.max(0, inner - visibleWidth(truncated));
    return `${this.purple("│")}${truncated}${" ".repeat(pad)}${this.purple("│")}`;
  }

  private ruleLine(inner: number): string {
    return this.purple(`├${"─".repeat(inner)}┤`);
  }

  private titleLine(inner: number): string {
    const peers = this.opts.getPeers();
    const sel = this.selectedPeer();
    const focus = this._focused ? " ⌨ typing captured here ·" : "";
    const foreign = this.opts.getForeignAgents?.() ?? [];
    const title = ` PEERS · ${peers.length} watching${foreign.length ? ` + ${foreign.length} elsewhere` : ""}${sel ? ` · ${sel.name}` : ""}${focus} `;
    const text = truncateToWidth(title, Math.max(1, inner - 2), "…");
    const right = Math.max(0, inner - 2 - visibleWidth(text));
    return `${this.purple("╭──")}${this.safeFg(this._focused ? "accent" : "dim", text)}${this.purple(`${"─".repeat(right)}╮`)}`;
  }

  private paneLines(peer: Peer, width: number): string[] {
    const t = this.opts.theme;
    const lines: string[] = [];
    for (const entry of peer.pane) {
      const cursor = entry.streaming ? this.safeFg("warning", " ▍") : "";
      const bodyWidth = entry.streaming ? width - 2 : width;
      if (entry.kind === "tick") {
        const prev = lines[lines.length - 1] ?? "";
        if (entry.text === "·" && /^·+$/.test(prev.replace(/\x1b\[[0-9;]*m/g, ""))) {
          lines[lines.length - 1] = this.safeFg("dim", prev.replace(/\x1b\[[0-9;]*m/g, "") + "·");
        } else {
          lines.push(this.safeFg("dim", entry.text));
        }
      } else if (entry.kind === "user") {
        lines.push(this.safeFg("accent", `❯ ${truncateToWidth(entry.text, width - 2)}`));
      } else if (entry.kind === "thinking") {
        for (const l of wrapTextWithAnsi(entry.text, bodyWidth)) lines.push(this.safeFg("dim", l));
        if (cursor && lines.length) lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1]!, width - 2) + cursor;
      } else if (entry.kind === "tool") {
        lines.push(this.safeFg("dim", `» ${truncateToWidth(entry.text, width - 5)}`) + cursor);
      } else if (entry.kind === "finding") {
        const color = entry.priority === "interrupt" ? "error" : entry.priority === "steering" ? "accent" : "dim";
        lines.push(this.safeFg(color, `◆ FINDING ${entry.priority ?? ""}`));
        for (const l of wrapTextWithAnsi(entry.text, width - 2)) lines.push(this.safeFg(color, `  ${l}`));
      } else if (entry.kind === "note") {
        lines.push(this.safeFg("warning", truncateToWidth(`! ${entry.text}`, width)));
      } else {
        for (const l of wrapTextWithAnsi(entry.text, bodyWidth)) lines.push(l);
        if (cursor && lines.length) lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1]!, width - 2) + cursor;
      }
    }
    return lines;
  }

  private emptyStateLines(inner: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push("  " + this.safeFg("accent", "No peers watching yet."));
    lines.push("");
    for (const l of [
      "  A peer is a partner agent living in this session: it wakes on its own",
      "  tick (minutes), inspects what the main agent just did, and pushes a",
      "  finding into the conversation the moment something is wrong. Each peer",
      "  is a real pi session you can resume in any terminal.",
    ])
      lines.push(this.safeFg("dim", l));
    lines.push("");
    lines.push("  " + this.safeFg("accent", "type /launch to start one") + this.safeFg("dim", "  (or /launch <role> <task…>)"));
    lines.push("");
    const roles = this.opts.getRoles();
    if (roles.length) {
      lines.push(this.safeFg("dim", "  available roles:"));
      for (const r of roles.slice(0, 8)) {
        lines.push("    " + this.safeFg("accent", r.name) + this.safeFg("dim", ` — ${r.description}`));
        lines.push(this.safeFg("dim", `      tick ${Math.round(r.tick / 60)}m · up to ${r.priorityCeiling} · ${r.context} context · ${r.source}`));
      }
    }
    return lines;
  }

  private inputFrameLines(width: number): string[] {
    const target = Math.max(1, width - 2);
    const prev = (this.input as any).focused;
    // btw's stability trick: render the editor unfocused so CURSOR_MARKER
    // doesn't perturb the frame; the overlay still owns keyboard input.
    (this.input as any).focused = false;
    try {
      return (this.input.render(target) as string[]).map((l) => `${this.purple("│")}${l}${this.purple("│")}`);
    } finally {
      (this.input as any).focused = prev;
    }
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(40, width);
    const inner = dialogWidth - 2;
    const peers = this.opts.getPeers();
    if (this.selected >= peers.length) this.selected = Math.max(0, peers.length - 1);
    const sel = this.selectedPeer();

    // Peer list (capped).
    const listLines: string[] = [];
    peers.slice(0, LIST_MAX).forEach((peer, i) => {
      const isSel = i === this.selected;
      const dot =
        peer.status === "thinking" ? this.safeFg("accent", "●")
        : peer.status === "error" ? this.safeFg("error", "●")
        : this.safeFg("dim", "●");
      const secs = Math.max(0, Math.round((peer.nextTickAt - Date.now()) / 1000));
      const eta = peer.busy ? "thinking…" : secs >= 90 ? `next ${Math.ceil(secs / 60)}m` : `next ${secs}s`;
      const head =
        `${isSel ? this.safeFg("accent", "❯ ") : "  "}${dot} ` +
        (isSel ? this.safeFg("accent", peer.name) : peer.name) +
        this.safeFg("dim", `  ${peer.role.name} · t${peer.tickCount} · ${eta}${peer.findings.length ? ` · ◆${peer.findings.length}` : ""}`);
      listLines.push(truncateToWidth(head, inner));
    });
    for (const f of (this.opts.getForeignAgents?.() ?? []).slice(0, LIST_MAX)) {
      listLines.push(
        truncateToWidth(
          `  ${this.safeFg("dim", "○")} ${this.safeFg("dim", f.name)}${this.safeFg("dim", `  ${f.role} · ${f.status} · ${f.mode ?? "watch"} · other session (read-only)`)}`,
          inner,
        ),
      );
    }
    if (peers.length > LIST_MAX) listLines.push(this.safeFg("dim", `  (+${peers.length - LIST_MAX} more — Tab to cycle)`));

    // Fixed geometry: everything except the viewport is chrome; the viewport
    // absorbs the rest and is padded, so total height NEVER changes between
    // renders (no drifting with background content).
    // FOCUS AFFORDANCE: only a FOCUSED panel has an input box at all — an
    // editor cursor in the panel therefore always means "keys go here".
    // Unfocused, the input area is one dim hint line.
    const inputLines = this._focused
      ? this.inputFrameLines(dialogWidth)
      : [this.frameLine(this.safeFg("dim", " ⌨ ctrl+alt+p to type to peers — your typing goes to the MAIN prompt"), inner)];
    const listChrome = listLines.length > 0 ? listLines.length + 1 : 0; // list + its rule (skipped entirely at 0 peers)
    const statusLines = 1;
    const chrome = 1 + listChrome + statusLines + 1 + inputLines.length + 1 + 1; // title, list+rule, status, rule, input, hints, bottom
    const maxRows = Math.max(16, this.opts.getMaxRows());
    const vh = Math.max(4, maxRows - chrome);
    this.viewportHeight = vh;

    const paneW = inner - 1;
    const raw = sel ? this.paneLines(sel, paneW) : this.emptyStateLines(inner);
    const wrapped: string[] = [];
    for (const l of raw) {
      if (!l) wrapped.push("");
      else wrapped.push(...wrapTextWithAnsi(l, paneW));
    }
    const maxScroll = Math.max(0, wrapped.length - vh);
    if (this.follow) this.scrollOffset = maxScroll;
    else {
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      if (this.scrollOffset >= maxScroll) this.follow = true;
    }
    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + vh);
    const padCount = Math.max(0, vh - visible.length);

    const lines: string[] = [this.titleLine(inner)];
    if (listLines.length > 0) {
      for (const l of listLines) lines.push(this.frameLine(l, inner));
      lines.push(this.ruleLine(inner));
    }
    for (const l of visible) lines.push(this.frameLine(l ? ` ${l}` : "", inner));
    for (let i = 0; i < padCount; i++) lines.push(this.frameLine("", inner));
    lines.push(this.ruleLine(inner));

    const hiddenAbove = this.scrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.scrollOffset);
    const scrollInfo = hiddenAbove || hiddenBelow ? ` · ↑${hiddenAbove} ↓${hiddenBelow}` : "";
    // Flashes expire — a 5s-old warning must not outlive the situation it
    // described (a stale 'no peer selected' next to a selected peer).
    if (this.flash && Date.now() - this.flashAt > 5000) this.flash = "";
    const status = this.flash
      ? this.safeFg("warning", ` ${this.flash}`)
      : sel
        ? this.safeFg("dim", truncateToWidth(` ${sel.modelLabel} · id ${shortId(sel.sessionId)} · ${sel.contextMode} · tick ${Math.round(sel.role.tick / 60)}m · ${sel.status} · ↑${fmtTok(sel.usage.input)} ↓${fmtTok(sel.usage.output)} $${sel.usage.costUsd.toFixed(2)}${scrollInfo} · task: ${sel.task}`, inner))
        : this.safeFg("dim", " launch a peer to begin");
    lines.push(this.frameLine(status, inner));
    lines.push(...inputLines);

    const hints = this._focused
      ? " type = talk · /yank copies · Tab switch · ↑↓/wheel scroll · esc close · ctrl+alt+l → main (mouse-select works there) "
      : " typing goes to the MAIN prompt · mouse selection/copy works here · ctrl+alt+l focus panel · ctrl+alt+p hide ";
    lines.push(this.frameLine(this.safeFg("dim", truncateToWidth(hints, inner)), inner));
    lines.push(this.purple(`╰${"─".repeat(inner)}╯`));
    return lines;
  }
}
