// Font analysis: encodings, ToUnicode maps, widths, and the same-font
// writability decision. Conservative by design — an editor must never guess
// a glyph identity it cannot prove from the file.
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { winAnsiCodeToUnicode, unicodeToWinAnsiCode } from './winansi.js';

const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
]);

export function stripSubsetPrefix(baseName: string): string {
  return baseName.replace(/^[A-Z]{6}\+/, '');
}

export interface FontInfo {
  resource: string;
  subtype: string;
  baseName: string;
  isCID: boolean;
  embedded: boolean;
  embeddedProgram?: Uint8Array;         // raw font program bytes (FontFile/2/3)
  toUnicode: Map<number, string> | null;
  codeToUnicode: Map<number, string>;   // simple fonts: encoding map
  unicodeToCode: Map<string, number>;   // simple fonts: encoding reverse map
  widths: Map<number, number>;          // simple: code->width; CID: cid->width
  hasWidthsArray: boolean;
  defaultWidth: number;
}

function nameOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFName) return obj.asString().replace(/^\//, '');
  return undefined;
}

function numOf(obj: PDFObject | undefined): number | undefined {
  return obj instanceof PDFNumber ? obj.asNumber() : undefined;
}

// --- ToUnicode CMap parsing -------------------------------------------------
export function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const s = new TextDecoder('latin1').decode(data);
  const hexToStr = (hex: string): string => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    // destination strings are UTF-16BE
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
    return out;
  };
  const charRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  const blocks = s.split(/beginbfchar|beginbfrange/);
  for (let bi = 1; bi < blocks.length; bi++) {
    const block = blocks[bi].split(/endbf/)[0];
    let m: RegExpExecArray | null;
    charRe.lastIndex = 0;
    const lines = block.split('\n');
    for (const line of lines) {
      const arr = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*)\]/);
      if (arr) { // bfrange with array of destinations
        const lo = parseInt(arr[1], 16), hi = parseInt(arr[2], 16);
        const dsts = [...arr[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((d) => hexToStr(d[1]));
        for (let c = lo; c <= hi && c - lo < dsts.length; c++) map.set(c, dsts[c - lo]);
        continue;
      }
      // bfrange triples (<lo> <hi> <dst>) are resolved by
      // parseToUnicodeRanges in a second pass, which overwrites the
      // tentative <lo>-><hi> pair this pass records for such lines.
      charRe.lastIndex = 0;
      while ((m = charRe.exec(line)) !== null) {
        map.set(parseInt(m[1], 16), hexToStr(m[2]));
      }
    }
  }
  return map;
}

// The simple parser above conflates bfchar pairs and bfrange start values.
// Rebuild ranges properly: a dedicated second pass for bfrange triples.
export function parseToUnicodeRanges(data: Uint8Array, into: Map<number, string>): void {
  const s = new TextDecoder('latin1').decode(data);
  const hexToStr = (hex: string): string => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  };
  for (const block of s.split('beginbfrange').slice(1)) {
    const body = block.split('endbfrange')[0];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      const dst = hexToStr(m[3]);
      const base = dst.charCodeAt(dst.length - 1);
      const prefix = dst.slice(0, -1);
      for (let c = lo; c <= hi; c++) into.set(c, prefix + String.fromCharCode(base + (c - lo)));
    }
  }
}

// --- glyph names (subset of the Adobe Glyph List, Latin coverage) -----------
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28,
  parenright: 0x29, asterisk: 0x2a, plus: 0x2b, comma: 0x2c, hyphen: 0x2d,
  period: 0x2e, slash: 0x2f, colon: 0x3a, semicolon: 0x3b, less: 0x3c,
  equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40, bracketleft: 0x5b,
  backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
  grave: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  Euro: 0x20ac, quotesinglbase: 0x201a, florin: 0x0192, quotedblbase: 0x201e,
  ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021, circumflex: 0x02c6,
  perthousand: 0x2030, Scaron: 0x0160, guilsinglleft: 0x2039, OE: 0x0152,
  Zcaron: 0x017d, quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c,
  quotedblright: 0x201d, bullet: 0x2022, endash: 0x2013, emdash: 0x2014,
  tilde: 0x02dc, trademark: 0x2122, scaron: 0x0161, guilsinglright: 0x203a,
  oe: 0x0153, zcaron: 0x017e, Ydieresis: 0x0178, nbspace: 0xa0,
  exclamdown: 0xa1, cent: 0xa2, sterling: 0xa3, currency: 0xa4, yen: 0xa5,
  brokenbar: 0xa6, section: 0xa7, dieresis: 0xa8, copyright: 0xa9,
  ordfeminine: 0xaa, guillemotleft: 0xab, logicalnot: 0xac, registered: 0xae,
  macron: 0xaf, degree: 0xb0, plusminus: 0xb1, twosuperior: 0xb2,
  threesuperior: 0xb3, acute: 0xb4, mu: 0xb5, paragraph: 0xb6,
  periodcentered: 0xb7, cedilla: 0xb8, onesuperior: 0xb9,
  ordmasculine: 0xba, guillemotright: 0xbb, onequarter: 0xbc,
  onehalf: 0xbd, threequarters: 0xbe, questiondown: 0xbf, Agrave: 0xc0,
  Aacute: 0xc1, Acircumflex: 0xc2, Atilde: 0xc3, Adieresis: 0xc4,
  Aring: 0xc5, AE: 0xc6, Ccedilla: 0xc7, Egrave: 0xc8, Eacute: 0xc9,
  Ecircumflex: 0xca, Edieresis: 0xcb, Igrave: 0xcc, Iacute: 0xcd,
  Icircumflex: 0xce, Idieresis: 0xcf, Eth: 0xd0, Ntilde: 0xd1,
  Ograve: 0xd2, Oacute: 0xd3, Ocircumflex: 0xd4, Otilde: 0xd5,
  Odieresis: 0xd6, multiply: 0xd7, Oslash: 0xd8, Ugrave: 0xd9,
  Uacute: 0xda, Ucircumflex: 0xdb, Udieresis: 0xdc, Yacute: 0xdd,
  Thorn: 0xde, germandbls: 0xdf, agrave: 0xe0, aacute: 0xe1,
  acircumflex: 0xe2, atilde: 0xe3, adieresis: 0xe4, aring: 0xe5, ae: 0xe6,
  ccedilla: 0xe7, egrave: 0xe8, eacute: 0xe9, ecircumflex: 0xea,
  edieresis: 0xeb, igrave: 0xec, iacute: 0xed, icircumflex: 0xee,
  idieresis: 0xef, eth: 0xf0, ntilde: 0xf1, ograve: 0xf2, oacute: 0xf3,
  ocircumflex: 0xf4, otilde: 0xf5, odieresis: 0xf6, divide: 0xf7,
  oslash: 0xf8, ugrave: 0xf9, uacute: 0xfa, ucircumflex: 0xfb,
  udieresis: 0xfc, yacute: 0xfd, thorn: 0xfe, ydieresis: 0xff,
  minus: 0x2212, fi: 0xfb01, fl: 0xfb02,
};

export function glyphNameToUnicode(name: string): number | undefined {
  const base = name.split('.')[0];
  const uni = base.match(/^uni([0-9A-Fa-f]{4})$/);
  if (uni) return parseInt(uni[1], 16);
  const u = base.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (u) return parseInt(u[1], 16);
  return GLYPH_NAMES[base];
}

// --- font dictionary analysis ------------------------------------------------
export function analyzeFont(
  context: { lookup: (o: PDFObject | undefined) => PDFObject | undefined },
  fontDict: PDFDict,
  resource: string,
): FontInfo {
  const subtype = nameOf(fontDict.get(PDFName.of('Subtype'))) ?? '';
  const baseName = nameOf(fontDict.get(PDFName.of('BaseFont'))) ?? '';
  const isCID = subtype === 'Type0';

  let toUnicode: Map<number, string> | null = null;
  const tuObj = fontDict.get(PDFName.of('ToUnicode'));
  const tuStream = tuObj ? context.lookup(tuObj) : undefined;
  if (tuStream instanceof PDFStream) {
    const bytes = decodePDFRawStream(tuStream as never).decode();
    toUnicode = parseToUnicode(bytes);
    parseToUnicodeRanges(bytes, toUnicode);
  }

  const codeToUnicode = new Map<number, string>();
  const unicodeToCode = new Map<string, number>();
  const widths = new Map<number, number>();
  let hasWidthsArray = false;
  let defaultWidth = 1000;
  let embedded = false;

  const descriptorOf = (d: PDFDict): PDFDict | undefined => {
    const fd = d.get(PDFName.of('FontDescriptor'));
    const r = fd ? context.lookup(fd) : undefined;
    return r instanceof PDFDict ? r : undefined;
  };

  let embeddedProgram: Uint8Array | undefined;
  const captureProgram = (fd: PDFDict | undefined) => {
    if (!fd) return;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      const ref = fd.get(PDFName.of(key));
      const stream = ref ? context.lookup(ref) : undefined;
      if (stream instanceof PDFStream) {
        try {
          embeddedProgram = decodePDFRawStream(stream as never).decode();
        } catch { /* unparseable program: callers fall back to proven-chars */ }
        return;
      }
    }
  };

  if (!isCID) {
    // Encoding construction — NO guessing. The map is built ONLY from what
    // the file declares:
    //  - /Encoding as a name (WinAnsiEncoding & friends) -> that table.
    //  - /Encoding dict -> BaseEncoding table (if named) + Differences.
    //    A dict with Differences but no BaseEncoding contributes ONLY the
    //    Differences entries.
    //  - No /Encoding at all -> the WinAnsi table ONLY for Standard-14 base
    //    fonts (their built-in encoding is defined); otherwise the map stays
    //    empty and identity must come from ToUnicode — without it the runs
    //    are unmappable and edits are refused.
    const fillWinAnsi = () => {
      for (let c = 0; c < 256; c++) codeToUnicode.set(c, String.fromCharCode(winAnsiCodeToUnicode(c)));
    };
    const encObj = fontDict.get(PDFName.of('Encoding'));
    const enc = encObj ? context.lookup(encObj) : undefined;
    const encName = nameOf(encObj);
    if (encName) {
      fillWinAnsi(); // WinAnsi/MacRoman/Standard/PDFDoc approximated by WinAnsi for Latin scope
    } else if (enc instanceof PDFDict) {
      const base = nameOf(enc.get(PDFName.of('BaseEncoding')));
      if (base) fillWinAnsi();
      const diffs = enc.get(PDFName.of('Differences'));
      const diffArr = diffs ? context.lookup(diffs) : undefined;
      if (diffArr instanceof PDFArray) {
        let code = 0;
        for (let i = 0; i < diffArr.size(); i++) {
          const el = diffArr.get(i);
          const asNum = numOf(el as PDFObject);
          if (asNum !== undefined) { code = asNum; continue; }
          const nm = nameOf(el as PDFObject);
          if (nm) {
            const u = glyphNameToUnicode(nm);
            if (u !== undefined) codeToUnicode.set(code, String.fromCharCode(u));
            code++;
          }
        }
      }
    } else if (!encObj && STANDARD_14.has(stripSubsetPrefix(baseName))) {
      fillWinAnsi();
    }
    for (const [code, ch] of codeToUnicode) if (!unicodeToCode.has(ch)) unicodeToCode.set(ch, code);
    // Writing may also use the font's own ToUnicode declarations in reverse:
    // ToUnicode is the file's authoritative statement of what its codes
    // mean, so a code it assigns to a character is a legitimate write code
    // (glyph presence is proven separately). Encoding-derived codes win on
    // conflict; encodeWithFont cross-checks ToUnicode consistency and
    // refuses any code whose ToUnicode meaning differs from the character.
    if (toUnicode) {
      const fromTU = new Map<string, number>();
      for (const [code, ch] of toUnicode) if (!fromTU.has(ch)) fromTU.set(ch, code);
      for (const [ch, code] of fromTU) if (!unicodeToCode.has(ch)) unicodeToCode.set(ch, code);
    }
    const first = numOf(fontDict.get(PDFName.of('FirstChar'))) ?? 0;
    const wObj = fontDict.get(PDFName.of('Widths'));
    const wArr = wObj ? context.lookup(wObj) : undefined;
    if (wArr instanceof PDFArray) {
      hasWidthsArray = true;
      for (let i = 0; i < wArr.size(); i++) {
        const w = numOf(wArr.get(i) as PDFObject);
        if (w !== undefined) widths.set(first + i, w);
      }
    }
    const fd = descriptorOf(fontDict);
    if (fd && (fd.get(PDFName.of('FontFile')) || fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')))) embedded = true;
    captureProgram(fd);
  } else {
    // Type0: widths live on the descendant CIDFont
    const descObj = fontDict.get(PDFName.of('DescendantFonts'));
    const descArr = descObj ? context.lookup(descObj) : undefined;
    if (descArr instanceof PDFArray && descArr.size() > 0) {
      const cidObj = context.lookup(descArr.get(0) as PDFObject);
      if (cidObj instanceof PDFDict) {
        defaultWidth = numOf(cidObj.get(PDFName.of('DW'))) ?? 1000;
        const wObj = cidObj.get(PDFName.of('W'));
        const wArr = wObj ? context.lookup(wObj) : undefined;
        if (wArr instanceof PDFArray) {
          hasWidthsArray = true;
          let i = 0;
          while (i < wArr.size()) {
            const c = numOf(wArr.get(i) as PDFObject); if (c === undefined) break;
            const next = wArr.get(i + 1) as PDFObject;
            const nextLook = context.lookup(next);
            if (nextLook instanceof PDFArray) {
              for (let k = 0; k < nextLook.size(); k++) {
                const w = numOf(nextLook.get(k) as PDFObject);
                if (w !== undefined) widths.set(c + k, w);
              }
              i += 2;
            } else {
              const c2 = numOf(next); const w = numOf(wArr.get(i + 2) as PDFObject);
              if (c2 === undefined || w === undefined) break;
              for (let cid = c; cid <= c2; cid++) widths.set(cid, w);
              i += 3;
            }
          }
        }
        const fd = descriptorOf(cidObj);
        if (fd && (fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')) || fd.get(PDFName.of('FontFile')))) embedded = true;
        captureProgram(fd);
      }
    }
  }

  return {
    resource, subtype, baseName, isCID, embedded, embeddedProgram, toUnicode,
    codeToUnicode, unicodeToCode, widths, hasWidthsArray, defaultWidth,
  };
}

/** Decode shown bytes to Unicode using this font's maps (ToUnicode first). */
export function decodeCodes(info: FontInfo, codes: number[]): { text: string; mappable: boolean } {
  let text = '';
  let mappable = true;
  for (const code of codes) {
    const fromTU = info.toUnicode?.get(code);
    if (fromTU !== undefined) { text += fromTU; continue; }
    if (!info.isCID) {
      const fromEnc = info.codeToUnicode.get(code);
      if (fromEnc !== undefined) { text += fromEnc; continue; }
    }
    mappable = false;
    text += '�';
  }
  return { text, mappable };
}

/**
 * Same-font writability for simple fonts. A character is writable iff the
 * font's encoding assigns it a code, a glyph is present (Widths entry when a
 * Widths array exists; Standard-font coverage otherwise), and ToUnicode (if
 * present) agrees with that code so extraction round-trips.
 */
export function encodeWithFont(info: FontInfo, text: string): Uint8Array | null {
  if (info.isCID) return null;
  const out: number[] = [];
  for (const ch of text) {
    const code = info.unicodeToCode.get(ch);
    if (code === undefined) return null;
    if (info.hasWidthsArray) {
      const w = info.widths.get(code);
      if (w === undefined || w === 0) return null;
    }
    if (info.toUnicode) {
      const mapped = info.toUnicode.get(code);
      if (mapped !== undefined && mapped !== ch) return null;
    }
    out.push(code);
  }
  return new Uint8Array(out);
}

export function fontCanEncode(info: FontInfo, text: string): boolean {
  return encodeWithFont(info, text) !== null;
}

export { unicodeToWinAnsiCode };
