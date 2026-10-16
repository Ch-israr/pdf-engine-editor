// WinAnsiEncoding (CP1252) mapping + the phase-1 writability policy.
//
// Phase scope (user decision 2026-10-15): English/Latin first. The script
// gate below is a POLICY, not a font-coverage accident: the bundled fallback
// font (DejaVu) does contain Arabic glyphs, but drawing Arabic without
// shaping (HarfBuzz) would produce disconnected, wrongly-ordered text.
// Non-Latin scripts therefore fail safely in this phase.

const CP1252_SPECIALS: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

export function winAnsiCodeToUnicode(code: number): number {
  if (code >= 0x80 && code <= 0x9f && CP1252_SPECIALS[code] !== undefined) {
    return CP1252_SPECIALS[code];
  }
  return code; // ASCII and Latin-1 ranges are identity in WinAnsi
}

const UNICODE_TO_WINANSI = new Map<number, number>();
for (let c = 0x00; c <= 0xff; c++) UNICODE_TO_WINANSI.set(winAnsiCodeToUnicode(c), c);

export function unicodeToWinAnsiCode(cp: number): number | undefined {
  return UNICODE_TO_WINANSI.get(cp);
}

export function isWinAnsiEncodable(text: string): boolean {
  for (const ch of text) {
    if (unicodeToWinAnsiCode(ch.codePointAt(0)!) === undefined) return false;
  }
  return true;
}

/** Chars writable in phase 1 via SOME path (same-font or fallback font). */
export function phaseScriptAllowed(text: string): { ok: boolean; bad: string[] } {
  const bad: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp === 0x09 || cp === 0x0a ||
      (cp >= 0x20 && cp <= 0x7e) ||          // ASCII printable
      (cp >= 0xa0 && cp <= 0xff) ||          // Latin-1 supplement
      (cp >= 0x100 && cp <= 0x17f) ||        // Latin Extended-A
      UNICODE_TO_WINANSI.has(cp);           // CP1252 punctuation (€, —, ", …)
    if (!ok && !bad.includes(ch)) bad.push(ch);
  }
  return { ok: bad.length === 0, bad };
}
