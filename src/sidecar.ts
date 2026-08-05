/** The peer sidecar — a docked overlay that reads like a real pi session (spec §8).
 *
 * Accordion of peers: each individually expandable, scrollable (keys + mouse
 * wheel), entry actions `i` (insert into the main prompt) and `y` (OSC-52 yank).
 * All colors are theme-derived; transcript idioms mirror pi's own (▍ streaming
 * cursor, dim thinking, one-line tool rows).
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Peer } from "./runtime.js";
import type { PeerRole } from "./types.js";
import { shortId } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Theme = { fg(role: string, text: string): string };

export interface SidecarOptions {
  getPeers: () => Peer[];
  getRoles: () => PeerRole[];
  theme: Theme;
  onClose: () => void;
  onUnfocus: () => void;
  onStop: (name: string) => void;
  onLaunch: () => void;
  insertText: (text: string) => void;
  yankText: (text: string, label: string) => void;
  requestRender: () => void;
  /** Current overlay row budget (btw pattern: derived from terminal each render). */
  getMaxRows: () => number;
}

function fg(theme: Theme, role: string, text: string): string {
  try {
    return theme.fg(role, text);
  } catch {
    return text;
  }
}

export class PeerSidecar {
  focused = false;
  private selected = 0;
  private expanded = new Set<string>();
  /** Per-peer scroll offset measured in lines from the tail (0 = follow). */
  private scroll = new Map<string, number>();
  private mouseEnabled = false;

  /** Recomputed each render from the overlay's actual row budget. */
  private paneHeight = 12;

  constructor(private opts: SidecarOptions) {
    // SGR mouse reporting so wheel events reach handleInput (btw-proven).
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    this.mouseEnabled = true;
  }

  dispose(): void {
    if (this.mouseEnabled) {
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
      this.mouseEnabled = false;
    }
  }

  // ------------------------------------------------------------------ render

  private paneLines(peer: Peer, width: number, theme: Theme): string[] {
    const t = theme;
    const lines: string[] = [];
    for (const entry of peer.pane) {
      if (entry.kind === "tick") {
        if (entry.text === "·") {
          // QUIET/skip ticks compress into the previous strip line.
          const prev = lines[lines.length - 1];
          if (prev !== undefined && /^·+$/.test(prev.replace(/\x1b\[[0-9;]*m/g, ""))) {
            lines[lines.length - 1] = fg(t, "dim", prev.replace(/\x1b\[[0-9;]*m/g, "") + "·");
          } else {
            lines.push(fg(t, "dim", "·"));
          }
        } else {
          lines.push(fg(t, "dim", entry.text));
        }
        continue;
      }
      // Streaming cursor is budgeted INSIDE the width so it can never push
      // a line past the right border.
      const cursor = entry.streaming ? fg(t, "warning", " ▍") : "";
      const bodyWidth = entry.streaming ? width - 2 : width;
      if (entry.kind === "thinking") {
        const wrapped = wrapTextWithAnsi(entry.text, bodyWidth);
        for (const l of wrapped) lines.push(fg(t, "dim", l));
        if (cursor && lines.length) lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1]!, width - 2) + cursor;
      } else if (entry.kind === "tool") {
        lines.push(fg(t, "dim", `» ${truncateToWidth(entry.text, width - 5)}`) + cursor);
      } else if (entry.kind === "finding") {
        const color = entry.priority === "interrupt" ? "error" : entry.priority === "steering" ? "accent" : "dim";
        lines.push(fg(t, color, `◆ FINDING ${entry.priority ?? ""}`));
        for (const l of wrapTextWithAnsi(entry.text, width - 2)) lines.push(fg(t, color, `  ${l}`));
      } else if (entry.kind === "note") {
        lines.push(fg(t, "warning", truncateToWidth(`! ${entry.text}`, width)));
      } else {
        for (const l of wrapTextWithAnsi(entry.text, bodyWidth)) lines.push(l);
        if (cursor && lines.length) lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1]!, width - 2) + cursor;
      }
    }
    return lines;
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const peers = this.opts.getPeers();
    // Selection stays in bounds even when peers stop underneath it.
    if (this.selected >= peers.length) this.selected = Math.max(0, peers.length - 1);
    const inner = Math.max(20, width - 2);
    // Viewport budget: overlay rows minus chrome (title, separator, hints,
    // border) and per-peer header/detail/resume rows — the rest is pane space
    // for the expanded peers (btw's transcriptViewportHeight discipline).
    const chrome = 4 + peers.length + [...this.expanded].length * 3;
    const expandedCount = Math.max(1, [...this.expanded].length);
    this.paneHeight = Math.max(8, Math.floor((this.opts.getMaxRows() - chrome) / expandedCount));
    const out: string[] = [];
    // Operator override of the theme-only rule: the OUTER frame is deep purple
    // so the sidecar unmistakably reads as an overlay floating above the
    // session. Bright purple = keys go HERE; dark purple = keys are back in
    // your editor (panel just watching). fg-only escape so no attrs leak.
    const bar = (s: string) => `\x1b[38;5;${this.focused ? 135 : 54}m${s}\x1b[39m`;

    const title = ` PEERS · ${peers.length} watching `;
    const pad = Math.max(0, inner - visibleWidth(title) - 1);
    out.push(bar("╭─") + fg(t, "accent", title) + bar("─".repeat(pad) + "╮"));

    const row = (content: string) => {
      const w = visibleWidth(content);
      const padded = w >= inner ? truncateToWidth(content, inner) : content + " ".repeat(inner - w);
      out.push(bar("│") + padded + bar("│"));
    };

    if (peers.length === 0) {
      // Empty state: make the panel worth opening — what peers are, which
      // roles exist, and the one key that starts everything.
      row("");
      row("  " + fg(t, "accent", "No peers watching yet."));
      row("");
      row(fg(t, "dim", "  A peer is a partner agent living in this session: it wakes every few"));
      row(fg(t, "dim", "  seconds, inspects what the main agent just did, and pushes a finding"));
      row(fg(t, "dim", "  into the conversation the moment something is wrong. Each peer is a"));
      row(fg(t, "dim", "  real pi session you can resume in any terminal."));
      row("");
      row("  " + fg(t, "accent", "press l to launch one") + fg(t, "dim", "   (or /peer launch <role> <task…>)"));
      row("");
      const roles = this.opts.getRoles();
      if (roles.length > 0) {
        row(fg(t, "dim", "  available roles:"));
        for (const r of roles.slice(0, 8)) {
          row("    " + fg(t, "accent", r.name) + fg(t, "dim", ` — ${truncateToWidth(r.description, Math.max(10, inner - r.name.length - 8))}`));
          row(fg(t, "dim", `      tick ${Math.round(r.tick / 60)}m · up to ${r.priorityCeiling} · ${r.context} context · ${r.source}`));
        }
      }
      row("");
    }

    peers.forEach((peer, i) => {
      const sel = i === this.selected;
      const open = this.expanded.has(peer.name);
      const dot =
        peer.status === "thinking" ? fg(t, "accent", "●")
        : peer.status === "error" ? fg(t, "error", "●")
        : peer.status === "stopped" ? fg(t, "dim", "○")
        : fg(t, "dim", "●");
      const secs = Math.max(0, Math.round((peer.nextTickAt - Date.now()) / 1000));
      const eta = secs >= 90 ? `${Math.ceil(secs / 60)}m` : `${secs}s`;
      const tickInfo = peer.busy ? "thinking" : peer.status === "stopped" ? "stopped" : `next ${eta}`;
      const head =
        `${sel && this.focused ? fg(t, "accent", "❯") : " "} ${open ? "▾" : "▸"} ${dot} ` +
        `${sel ? fg(t, "accent", peer.name) : peer.name} ` +
        fg(t, "dim", `${peer.role.name} · t${peer.tickCount} · ${tickInfo}${peer.findings.length ? ` · ◆${peer.findings.length}` : ""}`);
      row(truncateToWidth(head, inner));

      if (open) {
        row(fg(t, "dim", `   ${peer.modelLabel} · id ${shortId(peer.sessionId)} · ${peer.contextMode} · tick ${Math.round(peer.role.tick / 60)}m`));
        const paneW = inner - 4;
        const all = this.paneLines(peer, paneW, t);
        const off = this.scroll.get(peer.name) ?? 0;
        const end = Math.max(0, all.length - off);
        const start = Math.max(0, end - this.paneHeight);
        const view = all.slice(start, end);
        for (const l of view) row(`   ${fg(t, "dim", "│")}${l}`);
        if (all.length > this.paneHeight) {
          const pos = off === 0 ? "tail" : `-${off}`;
          row(fg(t, "dim", `   └ ${start > 0 ? "↑ " : ""}${all.length} lines · ${pos}${off > 0 ? " · ↓ to follow" : ""}`));
        }
        row(fg(t, "dim", truncateToWidth(`   resume: pi --session ${peer.sessionFile}`, inner)));
      }
    });

    out.push(bar("├" + "─".repeat(inner) + "┤"));
    const hints = this.focused
      ? " ↑↓ pick · ⏎ open · l launch · i insert · y/Y yank · r resume · x stop · q close · esc → type in main prompt (panel stays) "
      : " panel stays open · your typing goes to the main prompt · /peer close · ctrl+alt+p focus panel ";
    row(fg(t, "dim", truncateToWidth(hints, inner)));
    out.push(bar("╰" + "─".repeat(inner) + "╯"));
    return out;
  }

  // ------------------------------------------------------------------- input

  /** SGR wheel: up (btn 64) scrolls BACK (+lines from tail), down (65) toward tail. */
  private mouseDelta(data: string): number | null {
    const m = data.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
    if (!m) return null;
    const btn = Number(m[1]);
    if (btn === 64) return 3;
    if (btn === 65) return -3;
    return null;
  }

  private selectedPeer(): Peer | undefined {
    return this.opts.getPeers()[this.selected];
  }

  private scrollBy(delta: number): void {
    const peer = this.selectedPeer();
    if (!peer) return;
    if (!this.expanded.has(peer.name)) this.expanded.add(peer.name);
    const cur = this.scroll.get(peer.name) ?? 0;
    const next = Math.max(0, cur + delta);
    this.scroll.set(peer.name, next);
  }

  handleInput(data: string): boolean {
    const peers = this.opts.getPeers();
    const peer = this.selectedPeer();
    const wheel = this.mouseDelta(data);
    if (wheel !== null) {
      this.scrollBy(wheel);
      this.opts.requestRender();
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, peers.length - 1), this.selected + 1);
    } else if (matchesKey(data, Key.enter) || data === " ") {
      if (peer) {
        if (this.expanded.has(peer.name)) this.expanded.delete(peer.name);
        else this.expanded.add(peer.name);
      }
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(this.paneHeight - 2);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(-(this.paneHeight - 2));
    } else if (data === "i") {
      const f = peer?.findings[peer.findings.length - 1];
      if (f && peer) this.opts.insertText(`Peer ${peer.name} (${peer.role.name}) found [tick ${f.tick}]: ${f.body}`);
    } else if (data === "y") {
      const f = peer?.findings[peer.findings.length - 1];
      if (f) this.opts.yankText(f.body, "finding");
    } else if (data === "Y") {
      if (peer) {
        const text = peer.pane.map((p) => p.text).join("\n");
        this.opts.yankText(text, `${peer.name} pane`);
      }
    } else if (data === "r") {
      if (peer) this.opts.yankText(`pi --session ${peer.sessionFile}`, "resume command");
    } else if (data === "l") {
      this.opts.onLaunch();
    } else if (data === "x") {
      if (peer) this.opts.onStop(peer.name);
    } else if (data === "q") {
      this.opts.onClose();
      return true;
    } else if (matchesKey(data, Key.escape)) {
      this.opts.onUnfocus();
      return true;
    } else {
      return false;
    }
    this.opts.requestRender();
    return true;
  }
}
