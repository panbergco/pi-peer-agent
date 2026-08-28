/** Key-chord byte matching.
 *
 *  The panel must recognise its own chords from raw input bytes, because an
 *  overlay with focus sees keystrokes before pi's global shortcut layer does.
 *  Those matchers used to be hardcoded to ctrl+alt+p / ctrl+alt+l, so changing
 *  `toggleKey`/`focusKey` in config only half-worked (the global shortcut
 *  moved, the panel's own matcher did not). This derives both from the same
 *  configured string.
 *
 *  macOS note: there is no `cmd` chord to support — a terminal never receives
 *  Cmd (macOS reserves it for the terminal app itself), and pi's own keybinding
 *  vocabulary is ctrl/alt/shift only. What Mac users need instead is either
 *  Option-as-Meta enabled in their terminal, or a ctrl/shift chord. Both are
 *  handled here; the Option-glyph fallbacks below cover the common case where
 *  Option is NOT configured as Meta and instead produces a typographic glyph.
 */

/** What macOS emits for Option+<letter> when Option is not a Meta key. */
const MAC_OPTION_GLYPH: Record<string, string> = {
  a: "å", b: "∫", c: "ç", d: "∂", e: "´", f: "ƒ", g: "©", h: "˙", i: "ˆ",
  j: "∆", k: "˚", l: "¬", m: "µ", n: "˜", o: "ø", p: "π", q: "œ", r: "®",
  s: "ß", t: "†", u: "¨", v: "√", w: "∑", x: "≈", y: "¥", z: "Ω",
};

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** ⌘ on macOS. Only reportable by terminals speaking the kitty keyboard
   *  protocol -- legacy terminals cannot encode it at all. */
  super: boolean;
  key: string;
}

export function parseChord(spec: string): Chord | null {
  const parts = spec.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || key.length !== 1) return null;
  return {
    ctrl: parts.includes("ctrl"),
    alt: parts.includes("alt") || parts.includes("opt") || parts.includes("option"),
    shift: parts.includes("shift"),
    super: parts.includes("super") || parts.includes("cmd") || parts.includes("command"),
    key,
  };
}

/** Every byte sequence a terminal might send for this chord. */
export function chordSequences(spec: string): string[] {
  const c = parseChord(spec);
  if (!c) return [];
  const lower = c.key;
  const upper = lower.toUpperCase();
  const code = lower.charCodeAt(0);
  const ctrlByte = code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : null;
  // CSI-u (kitty keyboard protocol) modifier: 1 + shift(1) + alt(2) + ctrl(4)
  // + super(8). ⌘⌥P is therefore 1+2+8 = 11 -> "\x1b[112;11u".
  const mod = 1 + (c.shift ? 1 : 0) + (c.alt ? 2 : 0) + (c.ctrl ? 4 : 0) + (c.super ? 8 : 0);
  const out: string[] = [];

  if (c.ctrl && ctrlByte) {
    // alt is transmitted as an ESC prefix by most terminals.
    out.push(c.alt ? `\x1b${ctrlByte}` : ctrlByte);
  }
  // Only a chord with NO other modifier may claim the bare ESC+letter form.
  // (The cross-platform family turns ctrl+alt+X into a super+alt+X sibling,
  // which has no ctrl -- so testing !c.ctrl alone let the hazard back in
  // through the sibling. Caught by the assertion, not by reading the code.)
  if (c.alt && !c.ctrl && !c.super) {
    // ESC + letter is the standard encoding for an ALT-ONLY chord.
    //
    // It is deliberately NOT accepted for ctrl+alt chords. It was, briefly: a
    // "terminals drop the ctrl bit" fallback added while chasing a dead focus
    // key whose real cause turned out to be tmux `extended-keys off` (nothing
    // reached pi at all). The fallback was written for a phantom and is unsafe:
    // it makes ctrl+alt+L match plain Alt+L, and worse, Esc followed quickly by
    // "l" arrives as the same two bytes -- so the panel's Esc-to-close could be
    // read as a focus toggle, which looks exactly like "focus switching behaves
    // randomly". Removed on a peer agent's finding (observer-1, refs
    // src/keychord.ts).
    out.push(`\x1b${lower}`, `\x1b${upper}`);
  }
  // CSI-u (kitty/xterm modifyOtherKeys), lower and upper codepoints.
  if (mod > 1) {
    out.push(`\x1b[${code};${mod}u`, `\x1b[${upper.charCodeAt(0)};${mod}u`);
  }
  // macOS with Option NOT set as Meta: the glyph arrives on its own.
  if (c.alt && MAC_OPTION_GLYPH[lower]) out.push(MAC_OPTION_GLYPH[lower]);

  return [...new Set(out)];
}

/** A chord and its cross-platform sibling. ⌘⌥P and ctrl+alt+P are the same
 *  intent on different platforms, and a terminal may report either depending on
 *  whether the kitty protocol negotiated -- so both are always accepted. */
export function chordFamily(spec: string): string[] {
  const c = parseChord(spec);
  if (!c) return [spec];
  const out = new Set([spec]);
  if (c.super) out.add(spec.toLowerCase().replace(/\b(super|cmd|command)\b/g, "ctrl"));
  if (c.ctrl && !c.super) out.add(`super+${spec.toLowerCase().replace(/\bctrl\+/g, "")}`);
  return [...out];
}

export function matchesChord(data: string, spec: string): boolean {
  if (!data) return false;
  return chordFamily(spec).some((s) => chordSequences(s).includes(data));
}
