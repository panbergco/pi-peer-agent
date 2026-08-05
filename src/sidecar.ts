/** The peer sidecar — a docked overlay that reads like a real pi session (spec §8).
 *
 * Accordion of peers: each individually expandable, scrollable (keys + mouse
 * wheel), entry actions `i` (insert into the main prompt) and `y` (OSC-52 yank).
 * All colors are theme-derived; transcript idioms mirror pi's own (▍ streaming
 * cursor, dim thinking, one-line tool rows).
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Peer } from "./runtime.js";
import { shortId } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Theme = { fg(role: string, text: string): string };

export interface SidecarOptions {
  getPeers: () => Peer[];
  theme: Theme;
  onClose: () => void;
  onUnfocus: () => void;
  onStop: (name: string) => void;
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
      const cursor = entry.streaming ? fg(t, "warning", " ▍") : "";
      if (entry.kind === "thinking") {
        for (const l of wrapTextWithAnsi(entry.text, width)) lines.push(fg(t, "dim", l));
        if (cursor) lines[lines.length - 1] += cursor;
      } else if (entry.kind === "tool") {
        lines.push(fg(t, "dim", `⚙ ${truncateToWidth(entry.text, width - 3)}`) + cursor);
      } else if (entry.kind === "finding") {
        const color = entry.priority === "interrupt" ? "error" : entry.priority === "steering" ? "accent" : "dim";
        lines.push(fg(t, color, `◆ FINDING ${entry.priority ?? ""}`));
        for (const l of wrapTextWithAnsi(entry.text, width - 2)) lines.push(fg(t, color, `  ${l}`));
      } else if (entry.kind === "note") {
        lines.push(fg(t, "warning", truncateToWidth(`✦ ${entry.text}`, width)));
      } else {
        for (const l of wrapTextWithAnsi(entry.text, width)) lines.push(l);
        if (cursor && lines.length) lines[lines.length - 1] += cursor;
      }
    }
    return lines;
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const peers = this.opts.getPeers();
    const inner = Math.max(20, width - 2);
    // Viewport budget: overlay rows minus chrome (title, separator, hints,
    // border) and per-peer header/detail/resume rows — the rest is pane space
    // for the expanded peers (btw's transcriptViewportHeight discipline).
    const chrome = 4 + peers.length + [...this.expanded].length * 3;
    const expandedCount = Math.max(1, [...this.expanded].length);
    this.paneHeight = Math.max(8, Math.floor((this.opts.getMaxRows() - chrome) / expandedCount));
    const out: string[] = [];
    const bar = (s: string) => fg(t, "dim", s);

    const title = ` ⇄ PEERS · ${peers.length} watching `;
    const pad = Math.max(0, inner - visibleWidth(title) - 2);
    out.push(bar("╭─") + fg(t, "accent", title) + bar("─".repeat(pad) + "╮"));

    const row = (content: string) => {
      const w = visibleWidth(content);
      const padded = w >= inner ? truncateToWidth(content, inner) : content + " ".repeat(inner - w);
      out.push(bar("│") + padded + bar("│"));
    };

    if (peers.length === 0) {
      row(fg(t, "dim", "  no peers yet — /peer launch <role> <task…>"));
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
      const tickInfo = peer.busy ? "thinking" : peer.status === "stopped" ? "stopped" : `⟳ ${secs}s`;
      const head =
        `${sel && this.focused ? fg(t, "accent", "❯") : " "} ${open ? "▾" : "▸"} ${dot} ` +
        `${sel ? fg(t, "accent", peer.name) : peer.name} ` +
        fg(t, "dim", `${peer.role.name} · t${peer.tickCount} · ${tickInfo}${peer.findings.length ? ` · ◆${peer.findings.length}` : ""}`);
      row(truncateToWidth(head, inner));

      if (open) {
        row(fg(t, "dim", `   ⬢ ${peer.modelLabel} · ⌏ ${shortId(peer.sessionId)} · ${peer.contextMode} · ${peer.role.tick}s base`));
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
        row(fg(t, "dim", truncateToWidth(`   ⏻ pi --session ${peer.sessionFile}`, inner)));
      }
    });

    out.push(bar("├" + "─".repeat(inner) + "┤"));
    const hints = this.focused
      ? " ↑↓ pick · ⏎ open/close · PgUp/PgDn scroll · i insert · y/Y yank · r resume · x stop · q hide · esc back "
      : " ctrl+alt+p focus · /peer ";
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
