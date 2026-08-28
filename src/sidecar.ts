/** The peers panel — btw-faithful overlay.
 *
 * Faithful to pi-btw-sidecar's proven mechanics:
 *  - a REAL embedded pi-tui Editor at the bottom: type to the selected peer,
 *    Enter sends; full editing/paste/cursor UX (rendered unfocused for
 *    geometric stability — btw's trick);
 *  - FIXED dialog height (padded viewport) so the panel never shifts with
 *    background or content;
 *  - follow-tail transcript with maxScroll clamping; Up/Down/PgUp/PgDn
 *    scroll; Tab cycles peers;
 *  - /commands inside the input (/launch, /stop, /close, /insert, /yank,
 *    /resume, /retask, /help) — no single-letter hotkeys stealing typed text.
 *
 * Frame color is deliberately non-theme: deep purple = "this is an overlay".
 * Bright purple = keys go here; dark purple = your typing goes to the main
 * prompt.
 */

import { basename } from "node:path";
import { createRequire } from "node:module";

/** Shown in the panel title: which build you are actually looking at. */
const VERSION: string = (() => {
  try {
    return `v${createRequire(import.meta.url)("../package.json").version}`;
  } catch {
    return "";
  }
})();
import { chordFamily, matchesChord } from "./keychord.js";
import { rhythmOf, roleLine, roleSummary } from "./roles.js";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  matchesKey,
  setKeybindings,
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

/** Point THIS module's pi-tui keybinding singleton at the host's manager.
 *  The embedded Editor resolves bindings via its module-global getKeybindings();
 *  when an extension loads a second pi-tui instance, that global holds bare
 *  defaults without the user's config or terminal encodings — the root cause of
 *  panel keys drifting from the main prompt. Adopting the injected manager
 *  makes both prompts read the ONE configured source. */
export function adoptHostKeybindings(kb: unknown): void {
  if (kb && typeof (kb as { matches?: unknown }).matches === "function") {
    try {
      setKeybindings(kb as Parameters<typeof setKeybindings>[0]);
    } catch {
      /* defaults remain — never break the panel over a cosmetic mismatch */
    }
  }
}

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
  onAsk: (name: string, text: string) => void;
  /** /model [query] — change the selected peer's model (picker when ambiguous). */
  onModel: (name: string, model: string, done?: (error?: string) => void) => void;
  /** Models available in pi — for /model autocomplete. */
  getModels: () => string[];
  /** The agent that was selected last time the panel was open, so reopening
   *  returns to the conversation the human was actually in (its draft comes
   *  back with it). Lives beside the drafts, outside this component's life. */
  lastSelected?: () => string | null;
  onSelected?: (name: string | null) => void;
  /** Called whenever a draft is written into the shared map, so a session's
   *  half-written messages survive a resume. */
  onDraftsChanged?: () => void;
  /** Live height adjustment; returns the new ratio for the flash. */
  onResize?: (delta: 1 | -1) => number;
  /** Set an exact height percentage (20–90); returns the applied percent. */
  onResizeSet?: (pct: number) => number;
  getPanelPct?: () => number;
  /** Configured resize chords — matched here because a focused capturing
   *  widget sees raw bytes before pi's global shortcut layer. */
  resizeUpKeys?: string[];
  resizeDownKeys?: string[];
  /** Change the selected peer's tick interval (minutes). */
  onTick: (name: string, minutes: number) => void;
  /** Change an agent's authority from inside the panel. */
  onAuthority: (name: string, level: string) => void;
  /** Configured chords, so the panel matches exactly what pi's global
   *  shortcut layer was registered with. */
  toggleKey?: string;
  focusKey?: string;
  focusAliases?: string[];
  /** Report an escape sequence the panel could not match (diagnostics). */
  onUnmatchedKey?: (hex: string) => void;
  /** Agents in this project owned by ANOTHER session (durable state) — shown
   *  read-only so the panel is a complete census, never a partial view. */
  getForeignAgents?: () => Array<{
    name: string;
    role: string;
    status: string;
    mode?: string;
    /** True when the agent's owning session is gone — nothing ticks it. */
    orphaned?: boolean;
    /** True when the agent belongs to a DIFFERENT project than this session. */
    elsewhere?: boolean;
    /** Provenance — WHERE this agent comes from. A row the reader cannot place
     *  is noise (operator 2026-08-06: "it needs to show which projects the
     *  'others' are relating to, otherwise it makes no sense to show them"). */
    project?: string;
    owner?: string;
  }>;
  onRetask: (name: string, task: string) => void;
  insertText: (text: string) => void;
  yankText: (text: string, label: string) => void;
  requestRender: () => void;
  /** Draft text keyed by agent callsign. Owned by the extension so drafts
   * survive panel close/reopen, not only Tab switches within one component. */
  drafts: Map<string, string>;
}

const LIST_MAX = 6;

/** `/home/you/.pi/agent/peers/x.md` → `~/.pi/agent/peers/x.md`; a project role keeps
 *  its path relative so it reads as a place you can open. */
function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export class PeerSidecar extends Container implements Focusable {
  private readonly input: Editor;
  private selected = 0;
  /** Callsign whose draft is currently loaded in `input`. The numeric index is
   * not identity: peers can be added, stopped or reordered while the panel is
   * open. */
  private selectedName: string | null = null;
  private scrollOffset = 0;
  /** Modal choice rendered INSIDE the panel. */
  private picker: { title: string; items: Array<{ label: string; value: string }>; index: number; onPick: (value: string) => void } | null = null;
  /** When on, the next keypress reports its raw byte sequence instead of
   *  acting -- so a chord that "does nothing" can be identified exactly. */
  private keyProbe = false;
  private follow = true;
  private viewportHeight = 8;
  private flash = "";
  private flashAt = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    (this.input as any).focused = value;
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
                .map((r) => ({ value: r.name, label: r.name, description: `${r.description} · ${roleSummary(r).rhythm}` })),
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
      {
        name: "tick",
        description: "change the selected peer's tick interval",
        argumentHint: "<minutes>",
        getArgumentCompletions: (prefix: string) => [1, 5, 10, 15, 30, 60]
          .map(String)
          .filter((n) => n.startsWith(prefix.trim()))
          .map((n) => ({ value: n, label: `${n} minutes` })),
      },
      { name: "retask", description: "give the selected peer a new standing task", argumentHint: "<task…>" },
      { name: "insert", description: "insert the latest finding into the main prompt" },
      {
        name: "authority",
        description: "change selected agent authority",
        argumentHint: "[name] <level>",
        getArgumentCompletions: (prefix: string) => {
          const words = prefix.split(/\s+/);
          // First finite level: a peer callsign OR a level for the selected peer.
          if (words.length <= 1) {
            const q = words[0] ?? "";
            return [
              ...peerItems(q),
              ...["read-only", "write", "shell"]
                .filter((level) => level.startsWith(q))
                .map((level) => ({ value: level, label: level })),
            ];
          }
          // Second finite level: authority after an explicit peer callsign.
          const q = words.at(-1) ?? "";
          return ["read-only", "write", "shell"]
            .filter((level) => level.startsWith(q))
            .map((level) => ({ value: `${words[0]} ${level}`, label: level }));
        },
      },
      { name: "height", description: "panel height in % of the screen (bare = show current)", argumentHint: "[20-90]" },
      { name: "keys", description: "diagnose: show the raw bytes your terminal sends for the next key" },
      { name: "yank", description: "copy latest finding (or pane) to clipboard" },
      { name: "resume", description: "copy the standalone resume command" },
      { name: "close", description: "close the panel" },
      { name: "help", description: "list panel commands" },
    ];
    this.input.setAutocompleteProvider(new CombinedAutocompleteProvider(commands as any, process.cwd()));
    this.selectedName = this.selectedPeer()?.name ?? null;
    if (this.selectedName) this.setInput(this.opts.drafts.get(this.selectedName) ?? "");
    // The panel NEVER touches mouse-tracking terminal modes — in either
    // direction. It does not capture the mouse (operator ruling), and it must
    // not switch tracking OFF either: a dispose() here used to write a
    // "belt and braces" mouse-off sequence, which silently killed the HOST's
    // wheel scrolling in pi's fullscreen mode, where pi legitimately owns
    // mouse tracking (operator defect, 2026-08-06). Never turn off a terminal
    // mode you did not turn on.
  }

  dispose(): void {
    this.saveDraft();
  }

  /** Write the current input into the shared draft map without closing — used at
   *  session shutdown so an unsent message survives into the next session. */
  flushDraft(): void {
    this.saveDraft();
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

  /** Save the current editor buffer under the agent whose draft it actually
   * is. One shared Editor is sufficient; sharing its TEXT across agents was
   * the bug. */
  /** Text and completion state are one editor state. Clearing only the text
   *  left an invisible autocompleteState alive, so Tab/PageUp were captured by
   *  a list the operator could no longer see — the observed "Tab stopped
   *  working" failure. */
  private setInput(text: string): void {
    this.input.setText(text);
    (this.input as any).autocompleteState = null;
  }

  private saveDraft(): void {
    // (persisted by the host through onDraftsChanged below)
    if (!this.selectedName) return;
    const text = this.input.getText();
    if (text) this.opts.drafts.set(this.selectedName, text);
    else this.opts.drafts.delete(this.selectedName);
    this.opts.onDraftsChanged?.();
  }

  private loadDraft(name: string | null): void {
    this.selectedName = name;
    this.setInput(name ? (this.opts.drafts.get(name) ?? "") : "");
  }

  /** Every selection path routes here so a draft cannot leak through Tab,
   * peer_panel selection, list reordering, or panel close/reopen. */
  private switchSelected(index: number, render = true): void {
    const peers = this.opts.getPeers();
    const next = peers.length > 0 ? Math.max(0, Math.min(index, peers.length - 1)) : 0;
    const name = peers[next]?.name ?? null;
    if (name !== this.selectedName) {
      this.saveDraft();
      this.selected = next;
      this.loadDraft(name);
      this.opts.onSelected?.(name);
    } else {
      this.selected = next;
    }
    this.follow = true;
    this.scrollOffset = 0;
    if (render) this.opts.requestRender();
  }

  private restoredSelection = false;

  private syncSelected(): void {
    const peers = this.opts.getPeers();
    // First paint of a freshly opened panel: return to the agent the human was
    // last on, not to whoever happens to sort first.
    if (!this.restoredSelection && peers.length > 0) {
      this.restoredSelection = true;
      const want = this.opts.lastSelected?.();
      const idx = want ? peers.findIndex((p) => p.name === want) : -1;
      if (idx >= 0) {
        this.switchSelected(idx, false);
        return;
      }
    }
    const next = peers.length > 0 ? Math.min(this.selected, peers.length - 1) : 0;
    if ((peers[next]?.name ?? null) !== this.selectedName) this.switchSelected(next, false);
  }

  private openPicker(title: string, items: Array<{ label: string; value: string }>, onPick: (value: string) => void): void {
    if (items.length === 0) { this.setFlash(`${title}: nothing to choose from`); return; }
    this.flash = "";
    this.picker = { title, items, index: 0, onPick };
    this.opts.requestRender();
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
    this.switchSelected(idx);
    return true;
  }

  // ----------------------------------------------------------------- input

  private submit(raw: string): void {
    const value = raw.trim();
    // Same recall behavior as pi's prompt: every submitted line is reachable
    // with ↑ afterwards (the editor skips empties and consecutive duplicates).
    if (value) (this.input as any).addToHistory?.(value);
    if (this.selectedName) this.opts.drafts.delete(this.selectedName);
    this.setInput("");
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
    this.opts.onAsk(peer.name, value);
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
        this.setFlash("/launch [role task…] · /model [query] · /authority [name] <level> · /tick <min> · /height [20-90] · /stop [name] · /kill [name] · /retask <task…> · /insert · /yank · /resume · /close");
        return;
      case "model": {
        if (!peer) { this.setFlash("no peer selected — /launch first"); return; }
        const query = rest.join(" ").trim().toLowerCase();
        const models = this.opts.getModels().filter((m) => !query || m.toLowerCase().includes(query));
        const apply = (model: string) => this.opts.onModel(peer.name, model, (error) => { if (error) this.setFlash(error); });
        if (models.length === 0) { this.setFlash(`no model matching "${query}"`); return; }
        if (models.length === 1) { this.flash = ""; apply(models[0]!); return; }
        this.openPicker(
          `model for ${peer.name}${query ? ` · ${query}` : ""}`,
          models.map((m) => ({ label: m, value: m })),
          apply,
        );
        return;
      }
      case "authority": {
        const target = rest.length >= 2 ? rest[0]! : peer?.name;
        const level = rest.length >= 2 ? rest[1]! : rest[0];
        if (!target) { this.setFlash("no peer selected — /launch first"); return; }
        if (level) {
          if (!["read-only", "write", "shell"].includes(level)) { this.setFlash("usage: /authority [name] <read-only|write|shell>"); return; }
          this.opts.onAuthority(target, level);
          return;
        }
        this.openPicker(`authority for ${target}`, [
          { label: "read-only  — read, grep, find, ls", value: "read-only" },
          { label: "write      — + edit, write (own directory)", value: "write" },
          { label: "shell      — + run commands (own directory)", value: "shell" },
        ], (value) => this.opts.onAuthority(target, value));
        return;
      }
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
      case "height": {
        // The chord-free path: no desktop compositor can eat a typed command.
        const arg = rest.join(" ").trim();
        if (!arg) {
          this.setFlash(`panel height ${this.opts.getPanelPct?.() ?? "?"}% · /height 20-90 to set`);
          return;
        }
        const pct = Number.parseInt(arg, 10);
        if (!Number.isInteger(pct) || pct < 20 || pct > 90) {
          this.setFlash(`"${arg}" is not 20-90 — height unchanged`);
          return;
        }
        const applied = this.opts.onResizeSet?.(pct);
        if (applied !== undefined) this.setFlash(`panel height ${applied}%`);
        return;
      }
      case "keys": {
        this.keyProbe = true;
        this.setFlash("key probe ON — press any chord; its raw bytes appear here");
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

  /** Wheel events, IF the host ever forwards one.
   *
   *  Measured 2026-08-09: it does not. Wheel sequences injected into a session with the
   *  panel focused never reach the input hook — the host consumes them for its own
   *  scrolling before any widget sees them. Wiring this costs nothing and starts working
   *  the day the host forwards them; enabling mouse tracking here to grab them ourselves
   *  would break the terminal's own selection and scrollback, which the operator ruled
   *  against.
   *  Kept private and uncalled so the wheel-decoding logic is available if a
   *  future opt-in setting ever wants it. */
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

  /** The configured toggle chord in any encoding. The focused
   *  panel's editor would otherwise swallow the chord, making the global
   *  shortcut unable to close what it opened (btw guards identically). */
  /** Match a configured chord using BOTH pi's own key parser and our byte
   *  matcher.
   *
   *  This matters because a FOCUSED panel is a capturing overlay: it receives
   *  the keystroke instead of pi's global shortcut layer. If the panel
   *  recognised fewer encodings than pi does, the overlay would swallow the
   *  chord and the key would appear dead -- which is exactly what happened
   *  when the panel started opening focused (operator: "hours before it worked
   *  flawlessly", i.e. while the panel was still non-capturing and pi's parser
   *  saw every key). Deferring to pi's parser first guarantees the panel
   *  accepts precisely what the global layer accepts, and our own matcher adds
   *  the extras pi has no reason to know about (macOS Option glyphs, the
   *  ctrl-dropped fallback, the cross-platform cmd/ctrl family). */
  private matchesConfigured(data: string, spec: string): boolean {
    try {
      for (const variant of chordFamily(spec)) {
        if (matchesKey(data, variant as any)) return true;
      }
    } catch {
      /* pi's parser rejecting a spec must never disable our own matching */
    }
    return matchesChord(data, spec);
  }

  private isToggleChord(data: string): boolean {
    return this.matchesConfigured(data, this.opts.toggleKey ?? "ctrl+alt+o");
  }

  private isFocusChord(data: string): boolean {
    // Any configured focus chord OR alias. One letter can be swallowed by the
    // terminal itself with no error anywhere (WezTerm claims CTRL+L), so the
    // panel accepts every chord the extension registered.
    const specs = [this.opts.focusKey ?? "ctrl+alt+p", ...(this.opts.focusAliases ?? ["ctrl+alt+l"])];
    return specs.some((spec) => this.matchesConfigured(data, spec));
  }

  /** Entry point for WIDGET rendering, where the panel is not an overlay and
   *  therefore never receives input from the focus system. Keys arrive from
   *  ctx.ui.onTerminalInput instead; returning true tells the host we consumed
   *  the key, false lets it through to the main editor untouched. */
  handleInputExternally(data: string): boolean {
    if (!this.focused) {
      // Unfocused, only our own chords are ours to take.
      if (this.isToggleChord(data) || this.isFocusChord(data)) {
        this.handleInput(data);
        return true;
      }
      return false;
    }
    this.handleInput(data);
    return true;
  }

  handleInput(data: string): void {
    if (this.picker) {
      const p = this.picker;
      if (data === "\x1b" || data === "\x03") { this.picker = null; this.setFlash("cancelled"); return; }
      if (data === "\r" || data === "\n") {
        const chosen = p.items[p.index]; this.picker = null; if (chosen) p.onPick(chosen.value); this.opts.requestRender(); return;
      }
      if (data === "\x1b[A" || data === "\x10") { p.index = (p.index - 1 + p.items.length) % p.items.length; this.opts.requestRender(); return; }
      if (data === "\x1b[B" || data === "\x0e") { p.index = (p.index + 1) % p.items.length; this.opts.requestRender(); return; }
      return;
    }
    // Passive key telemetry: a focused panel sees raw bytes. If an
    // escape-sequence-looking key arrives that matches NOTHING, record it, so a
    // chord that "does nothing" on someone else's terminal can be diagnosed
    // from state instead of asking them to describe it.
    if (data.length > 1 && data.charCodeAt(0) === 27 && !this.isToggleChord(data) && !this.isFocusChord(data)) {
      this.opts.onUnmatchedKey?.(
        [...data].map((ch) => "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
      );
    }
    if (this.keyProbe) {
      this.keyProbe = false;
      const hex = [...data].map((ch) => "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      this.setFlash(`raw bytes: ${hex}  (matches toggle=${this.isToggleChord(data)} focus=${this.isFocusChord(data)})`);
      return;
    }
    if (this.isToggleChord(data)) {
      this.opts.onClose();
      return;
    }
    // Panel height, focused path (the widget sees raw bytes before pi's
    // global shortcut layer; the unfocused path is registered there).
    // Chords come from config — GNOME eats ctrl+alt+arrows at the compositor,
    // so shift+alt siblings ship as defaults alongside.
    const upChords = this.opts.resizeUpKeys ?? ["ctrl+alt+up", "shift+alt+up"];
    const downChords = this.opts.resizeDownKeys ?? ["ctrl+alt+down", "shift+alt+down"];
    const resizeUpHit = upChords.some((c) => matchesKey(data, c as never));
    if (resizeUpHit || downChords.some((c) => matchesKey(data, c as never))) {
      const ratio = this.opts.onResize?.(resizeUpHit ? 1 : -1);
      if (ratio !== undefined) this.setFlash(`panel height ${Math.round(ratio * 100)}%`);
      return;
    }
    if (this.isFocusChord(data) || matchesKey(data, Key.ctrl("c"))) {
      // Ctrl-C follows the same focus-return path as the configured chord:
      // keep the panel and its draft visible, but hand typing back to main.
      this.opts.onUnfocus();
      return;
    }
    // While the autocomplete list is open, ↑↓/Tab/Enter belong to it.
    // Otherwise shift+↑↓ scroll the peer's pane; every other key — including
    // ↑↓ (multi-line cursor movement, input history at the boundaries), Home,
    // End, word jumps, kill/yank, newline, paste — belongs to the embedded
    // editor, which reads the host's adopted keybinding manager and therefore
    // behaves exactly like pi's own prompt.
    //
    // NOT PgUp/PgDn: pi's host consumes those before a focused widget ever
    // sees them (measured 2026-08-06 — shift+↑ and alt+↑ arrive as raw bytes,
    // PageUp produces no panel event at all), which silently left the pane
    // unscrollable. They stay matched below in case a host ever forwards them.
    const wheel = this.mouseDelta(data);
    if (wheel !== null) {
      this.scrollBy(wheel);
      return;
    }
    const acOpen = Boolean((this.input as any).autocompleteState);
    if (!acOpen) {
      if (matchesKey(data, Key.shift(Key.up)) || matchesKey(data, Key.pageUp)) {
        this.scrollBy(-(Math.max(1, this.viewportHeight - 1)));
        return;
      }
      if (matchesKey(data, Key.shift(Key.down)) || matchesKey(data, Key.pageDown)) {
        this.scrollBy(Math.max(1, this.viewportHeight - 1));
        return;
      }
      // Line by line. A page jump was the ONLY way to move the transcript, which
      // reads as "it does not scroll" when you are trying to re-read one line
      // (operator, 2026-08-09). Alt+arrow is measured to arrive in a focused panel.
      if (matchesKey(data, Key.alt(Key.up))) {
        this.scrollBy(-1);
        return;
      }
      if (matchesKey(data, Key.alt(Key.down))) {
        this.scrollBy(1);
        return;
      }
      // Straight to the beginning or back to live, for a long transcript.
      if (matchesKey(data, Key.shift(Key.home)) || matchesKey(data, Key.alt(Key.home))) {
        this.scrollBy(-1_000_000);
        return;
      }
      if (matchesKey(data, Key.shift(Key.end)) || matchesKey(data, Key.alt(Key.end))) {
        this.follow = true;
        this.scrollBy(1_000_000);
        return;
      }
      if (matchesKey(data, Key.tab)) {
        const n = this.opts.getPeers().length;
        if (n > 0) this.switchSelected((this.selected + 1) % n);
        return;
      }
    }
    if (matchesKey(data, Key.escape)) {
      // Esc clears a draft first; on an empty input it CLOSES the panel
      // (operator ruling). Handing keys to main without closing is the focus key.
      if (this.input.getText().length > 0) {
        this.setInput("");
        this.opts.requestRender();
      } else {
        this.opts.onClose();
      }
      return;
    }
    if (this.opts.keybindings.matches(data, "app.clear")) {
      if (this.input.getText().length > 0) {
        this.setInput("");
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
    const all = this.opts.getForeignAgents?.() ?? [];
    // An orphan is not "in another session" — its session is gone and nothing
    // ticks it. Count it as what it is (operator 2026-08-06).
    const orphans = all.filter((f) => f.orphaned);
    const foreign = all.filter((f) => !f.orphaned);
    // Name the origin in the title rather than an unplaceable count. One other
    // project -> name it; several -> say how many projects, not just agents.
    const origins = [...new Set(foreign.map((f) => f.project ?? "").filter(Boolean))];
    const foreignLabel = (!foreign.length
      ? ""
      : origins.length === 1
        ? ` + ${foreign.length} in ${basename(origins[0]!)}`
        : origins.length > 1
          ? ` + ${foreign.length} across ${origins.length} projects`
          : ` + ${foreign.length} in other sessions`) + (orphans.length ? ` + ${orphans.length} orphaned` : "");
    // An agent that has ENDED is not watching anything: a retired task, a
    // completed or exhausted goal is counted separately, or the title claims a
    // crew that no longer exists (seen in a panel screenshot: "2
    // watching" over two retired tasks).
    const ENDED = ["retired", "done", "exhausted"];
    const watching = peers.filter((p) => !ENDED.includes(p.status)).length;
    const retired = peers.filter((p) => p.status === "retired").length;
    const otherEnded = peers.filter((p) => p.status === "done" || p.status === "exhausted").length;
    const endedLabel = `${retired ? ` + ${retired} retired` : ""}${otherEnded ? ` + ${otherEnded} ended` : ""}`;
    // What the crew has cost, where the crew is: a total nobody has to ask for.
    const crewCost = peers.reduce((sum, p) => sum + (p.usage?.costUsd ?? 0), 0);
    const crewTokens = peers.reduce((sum, p) => sum + (p.usage?.input ?? 0) + (p.usage?.output ?? 0), 0);
    // Subscription providers report no price, so a crew can spend real tokens at a
    // reported cost of zero. Show what is actually known rather than a misleading
    // "$0.00": dollars when there are dollars, tokens otherwise.
    const costLabel = crewCost > 0 ? ` · $${crewCost.toFixed(2)}` : crewTokens > 0 ? ` · ${fmtTok(crewTokens)} tok` : "";
    const title = ` PEERS ${VERSION} · ${watching} watching${endedLabel}${foreignLabel}${costLabel}${sel ? ` · ${sel.name}` : ""}${focus} `;
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
        // QUIET / FINDING[...] are machine protocol, not human prose. They used
        // to leak verbatim into the panel, forcing the operator to learn an
        // internal token ("I do not know what QUIET means") and duplicating a
        // finding that is already rendered as its own ◆ FINDING entry.
        // Preserve streaming text verbatim; clean only settled turns so a
        // half-written verdict never flickers in and out.
        const hadQuiet = !entry.streaming && /^\s*QUIET\s*$/im.test(entry.text);
        const clean = entry.streaming
          ? entry.text
          : entry.text
              .replace(/^\s*QUIET\s*$/gim, "")
              .replace(/^\s*FINDING\[(?:info|steering|interrupt)\]\s*:[\s\S]*$/gim, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
        if (clean) {
          for (const l of wrapTextWithAnsi(clean, bodyWidth)) lines.push(l);
        } else if (hadQuiet) {
          lines.push(this.safeFg("dim", "✓ Checked — nothing needs attention."));
        }
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
        // Two lines per role, not three: adding the file on its own line pushed a
        // five-role crew past the panel's visible area and the list header scrolled
        // off entirely (caught by a drill re-run). The file IS the template, so it
        // stays — on the same line as the rest of the contract.
        // One formatter, every surface — see roleLine() in roles.ts.
        lines.push(this.safeFg("dim", `      ${roleLine(r)}${r.file ? ` · ${shortenPath(r.file)}` : ""}`));
      }
      lines.push(this.safeFg("dim", "  your own roles: ~/.pi/agent/peers/<name>.md · this project: .pi/peers/<name>.md (wins)"));
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
    this.syncSelected();
    const sel = this.selectedPeer();
    // Reserve the panel's full height before rendering a variable-size picker.
    // The picker gets only the rows the viewport can surrender while keeping
    // four transcript rows, so opening a long model list never grows the
    // below-editor widget or shifts the main conversation/footer.
    const inputLines = this._focused
      ? this.inputFrameLines(dialogWidth)
      : [
          this.frameLine(
            this.safeFg("dim", ` ⌨ ${this.opts.focusKey ?? "ctrl+alt+p"} to type to peers — your typing goes to the MAIN prompt`),
            inner,
          ),
        ];
    const maxRows = Math.max(16, this.opts.getMaxRows());

    const pickerLines: string[] | null = this.picker ? (() => {
      const p = this.picker!;
      const out = [
        this.safeFg("accent", ` ${p.title}`),
        sel ? this.safeFg("dim", ` ❯ ● ${sel.name}  ${sel.role.name} · current ${sel.modelLabel}`) : "",
        "",
      ];
      const limit = Math.max(1, maxRows - inputLines.length - 15);
      const start = Math.max(0, Math.min(p.index - Math.floor(limit / 2), p.items.length - limit));
      for (let i = start; i < Math.min(p.items.length, start + limit); i++) {
        const item = p.items[i]!;
        out.push(i === p.index ? this.safeFg("accent", ` ❯ ${item.label}`) : this.safeFg("dim", `   ${item.label}`));
      }
      out.push("", this.safeFg("dim", " ↑↓ choose · enter select · esc cancel"));
      return out;
    })() : null;

    // Peer list (capped).
    const listLines: string[] = [];
    peers.slice(0, LIST_MAX).forEach((peer, i) => {
      const isSel = i === this.selected;
      const dot =
        peer.status === "thinking" ? this.safeFg("accent", "●")
        : peer.status === "error" ? this.safeFg("error", "●")
        : this.safeFg("dim", "●");
      const secs = Math.max(0, Math.round((peer.nextTickAt - Date.now()) / 1000));
      const ended = peer.status === "done" || peer.status === "exhausted" || peer.status === "stopped" || peer.status === "retired";
      const eta = ended ? peer.status : peer.busy ? "thinking…" : secs >= 90 ? `next ${Math.ceil(secs / 60)}m` : `next ${secs}s`;
      const mode = peer.mode === "mission"
        ? "MISSION"
        : peer.mode === "task"
        ? (peer.wave ? `TASK·${peer.wave.key}` : "TASK")
        : peer.mode === "goal"
        ? `GOAL ${peer.cycles}/${peer.objective?.maxCycles ?? 20}`
        : "WATCH";
      const head =
        `${isSel ? this.safeFg("accent", "❯ ") : "  "}${dot} ` +
        (isSel ? this.safeFg("accent", peer.name) : peer.name) +
        // An ELEVATED agent must never be mistaken for a read-only one: it can
        // change the project. Marked before anything else on the row.
        ((peer.role.authority ?? "read-only") !== "read-only"
          ? this.safeFg("warning", `  ⚡${peer.role.authority}`)
          : "") +
        this.safeFg("dim", `  ${peer.role.name} · ${mode} · t${peer.tickCount} · ${eta}${peer.findings.length ? ` · ◆${peer.findings.length}` : ""}`);
      listLines.push(truncateToWidth(head, inner));
    });
    for (const f of (this.opts.getForeignAgents?.() ?? []).slice(0, LIST_MAX)) {
      listLines.push(
        truncateToWidth(
          `  ${this.safeFg("dim", "○")} ${this.safeFg("dim", f.name)}${this.safeFg(
            "dim",
            `  ${f.role} · ${f.orphaned ? "orphaned — its session is gone" : f.status} · ${f.mode ?? "watch"} · ${
              // An orphan in THIS project can be adopted, so say how — the project
              // label was winning this branch and left the operator with a fact and
              // no verb. An orphan from another project cannot be adopted here.
              f.orphaned
                ? f.elsewhere
                  ? `stranded in project ${basename(f.project ?? "")}`
                  : `adopt it here: /peers attach ${f.name}`
                : f.project
                  ? `project ${basename(f.project)}`
                  : "other session"
            }${f.owner ? ` · session ${f.owner}` : ""} (read-only)`,
          )}`,
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
    const shownList = pickerLines ?? listLines;
    const listChrome = shownList.length > 0 ? shownList.length + 1 : 0; // list + its rule (skipped entirely at 0 peers)
    const statusLines = 1;
    const chrome = 1 + listChrome + statusLines + 1 + inputLines.length + 1 + 1; // title, list+rule, status, rule, input, hints, bottom
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
    if (shownList.length > 0) {
      for (const l of shownList) lines.push(this.frameLine(l, inner));
      lines.push(this.ruleLine(inner));
    }
    for (const l of visible) lines.push(this.frameLine(l ? ` ${l}` : "", inner));
    for (let i = 0; i < padCount; i++) lines.push(this.frameLine("", inner));
    lines.push(this.ruleLine(inner));

    const hiddenAbove = this.scrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.scrollOffset);
    const scrollInfo = hiddenAbove || hiddenBelow
      ? ` · ${hiddenAbove} line${hiddenAbove === 1 ? "" : "s"} above${hiddenBelow ? `, ${hiddenBelow} below` : ""} — shift+↑↓ page, alt+↑↓ line${hiddenBelow ? ", shift+End newest" : ""}`
      : "";
    // Flashes expire — a 5s-old warning must not outlive the situation it
    // described (a stale 'no peer selected' next to a selected peer).
    if (this.flash && Date.now() - this.flashAt > 5000) this.flash = "";
    const status = this.flash
      ? this.safeFg("warning", ` ${this.flash}`)
      : sel
        ? this.safeFg("dim", truncateToWidth(
            ` ${sel.mode === "mission" ? `MISSION · works its charge ${rhythmOf(sel)} · tick ${sel.tickCount}` : sel.mode === "task" ? `TASK · one engagement${sel.gate ? ` · gate ${sel.gatePassed ? "passed" : "not passed"}` : ""}${sel.handoff ? ` · handed off: ${sel.handoff.summary.slice(0, 50)}` : ""}` : sel.mode === "goal" ? `GOAL cycle ${sel.cycles}/${sel.objective?.maxCycles ?? 20} · ${sel.objective?.kind}:${sel.objective?.value}` : "WATCH"}` +
            ` · ${sel.modelLabel} · id ${shortId(sel.sessionId)} · ${sel.contextMode} · ${rhythmOf(sel)} · ${sel.status} · ↑${fmtTok(sel.usage.input)} ↓${fmtTok(sel.usage.output)} $${sel.usage.costUsd.toFixed(2)}${scrollInfo} · task: ${sel.task}`,
            inner,
          ))
        : this.safeFg("dim", " launch a peer to begin");
    lines.push(this.frameLine(status, inner));
    lines.push(...inputLines);

    const hints = this._focused
      ? ` type = ask · /yank copies · Tab switch · ↑ history · shift+↑↓ scroll · esc close · ctrl+c/${this.opts.focusKey ?? "ctrl+alt+p"} → main `
      : ` typing goes to the MAIN prompt · ${this.opts.focusKey ?? "ctrl+alt+p"} focus panel · ${this.opts.toggleKey ?? "ctrl+alt+o"} hide `;
    lines.push(this.frameLine(this.safeFg("dim", truncateToWidth(hints, inner)), inner));
    lines.push(this.purple(`╰${"─".repeat(inner)}╯`));
    return lines;
  }
}
