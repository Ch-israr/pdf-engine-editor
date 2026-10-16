// Page walker: resolves resources/fonts, replays the content stream's
// graphics + text state, and returns every text-showing operation as a run
// with its decoded text, origin, size, colour, and byte ranges.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRef, PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { groupOps, tokenize, type Op, type Token } from './content.js';
import { analyzeFont, decodeCodes, type FontInfo } from './fonts.js';

export interface RunColor { r: number; g: number; b: number }

export interface TextRun {
  ordinal: number;          // index among show-ops on this page
  operator: string;         // Tj | TJ | ' | "
  text: string;
  mappable: boolean;
  codes: number[];
  x: number; y: number;     // origin in page user space
  angleDeg: number;         // text baseline angle from the text matrix
  fontResource: string;
  fontSize: number;
  color: RunColor;
  opStart: number; opEnd: number;         // whole show-op byte range
  operandStart: number; operandEnd: number; // shown-string/array byte range
  // Text state at show time and the run's total advance — recorded so the
  // fragment editor can compute exact sub-run positions with the same math
  // the walker used (additive fields; whole-run editing does not use them).
  charSpacing: number;   // Tc, in unscaled text-space units
  wordSpacing: number;   // Tw
  hScale: number;        // Tz, percent
  endX: number; endY: number; // text position after this run (page user space)
  advancePt: number;          // total advance incl. TJ adjustments (walker units)
}

export interface PageData {
  pageIndex: number;
  content: Uint8Array;      // decoded (concatenated) content stream bytes
  runs: TextRun[];
  fonts: Map<string, FontInfo>;
}

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

function mul(m1: Mat, m2: Mat): Mat {
  // row-vector convention: p' = p * M ; result = m1 followed by m2
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}
const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];
function apply(m: Mat, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function resolveObj(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj === undefined) return undefined;
  return doc.context.lookup(obj);
}

function pageResources(doc: PDFDocument, pageDict: PDFDict): PDFDict | undefined {
  let d: PDFDict | undefined = pageDict;
  while (d) {
    const res = resolveObj(doc, d.get(PDFName.of('Resources')));
    if (res instanceof PDFDict) return res;
    const parent = resolveObj(doc, d.get(PDFName.of('Parent')));
    d = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

function pageContentBytes(doc: PDFDocument, pageDict: PDFDict): Uint8Array {
  const contents = resolveObj(doc, pageDict.get(PDFName.of('Contents')));
  const parts: Uint8Array[] = [];
  const pushStream = (o: PDFObject | undefined) => {
    if (o instanceof PDFStream) parts.push(decodePDFRawStream(o as never).decode());
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) pushStream(resolveObj(doc, contents.get(i) as PDFObject));
  } else {
    pushStream(contents);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function extractPage(doc: PDFDocument, pageIndex: number): PageData {
  const page = doc.getPage(pageIndex);
  const pageDict = page.node;
  const content = pageContentBytes(doc, pageDict);
  const fonts = new Map<string, FontInfo>();

  const resources = pageResources(doc, pageDict);
  const fontDictObj = resources ? resolveObj(doc, resources.get(PDFName.of('Font'))) : undefined;
  if (fontDictObj instanceof PDFDict) {
    const keys = fontDictObj.keys();
    for (const key of keys) {
      const name = key.asString().replace(/^\//, '');
      const fd = resolveObj(doc, fontDictObj.get(key));
      if (fd instanceof PDFDict) {
        fonts.set(name, analyzeFont({ lookup: (o) => resolveObj(doc, o) }, fd, name));
      }
    }
  }

  const ops = groupOps(tokenize(content));
  const runs: TextRun[] = [];

  // graphics state
  let ctm: Mat = IDENT;
  const ctmStack: Mat[] = [];
  // text state
  let inText = false;
  let tm: Mat = IDENT, tlm: Mat = IDENT;
  let fontResource = '';
  let fontSize = 0;
  let tc = 0, tw = 0, tz = 100, tl = 0;
  let color: RunColor = { r: 0, g: 0, b: 0 };

  const nums = (op: Op) => op.operands.filter((t) => t.kind === 'number').map((t) => t.num!);

  const advanceAndOrigin = (info: FontInfo | undefined, codes: number[], tjAdjust: number) => {
    const origin = apply(ctm, tm[4], tm[5]);
    const lin: Mat = mul(tm, ctm);
    const angleDeg = Math.atan2(lin[1], lin[0]) * 180 / Math.PI;
    let adv = 0;
    if (info) {
      for (const code of codes) {
        const w = info.widths.get(code) ?? (info.isCID ? info.defaultWidth : 0);
        adv += (w / 1000) * fontSize * (tz / 100);
        adv += tc;
        const ch = info.isCID ? undefined : info.codeToUnicode.get(code);
        if (ch === ' ') adv += tw;
      }
    }
    adv += (-tjAdjust / 1000) * fontSize;
    tm = mul(translate(adv, 0), tm);
    const end = apply(ctm, tm[4], tm[5]);
    return { origin, angleDeg, adv, end };
  };

  const showOp = (op: Op, codes: number[], operand: Token, tjAdjust: number) => {
    const info = fonts.get(fontResource);
    if (!info) return;
    const { origin, angleDeg, adv, end } = advanceAndOrigin(info, codes, tjAdjust);
    const { text, mappable } = decodeCodes(info, codes);
    runs.push({
      ordinal: runs.length,
      operator: op.operator,
      text, mappable, codes,
      x: origin[0], y: origin[1],
      angleDeg,
      fontResource, fontSize,
      color: { ...color },
      opStart: op.start, opEnd: op.end,
      operandStart: operand.start, operandEnd: operand.end,
      charSpacing: tc, wordSpacing: tw, hScale: tz,
      endX: end[0], endY: end[1], advancePt: adv,
    });
  };

  const splitCodes = (bytes: Uint8Array, info: FontInfo | undefined): number[] => {
    if (!info) return [];
    if (info.isCID) {
      const out: number[] = [];
      for (let i = 0; i + 1 < bytes.length + 1 && i + 1 <= bytes.length; i += 2) {
        out.push((bytes[i] << 8) | bytes[i + 1]);
      }
      if (bytes.length % 2 === 1) out.push(bytes[bytes.length - 1] << 8);
      return out;
    }
    return [...bytes];
  };

  for (const op of ops) {
    switch (op.operator) {
      case 'q': ctmStack.push(ctm); break;
      case 'Q': ctm = ctmStack.pop() ?? IDENT; break;
      case 'cm': { const v = nums(op); if (v.length === 6) ctm = mul(v as Mat, ctm); break; }
      case 'BT': inText = true; tm = IDENT; tlm = IDENT; break;
      case 'ET': inText = false; break;
      case 'Tf': {
        const nameTok = op.operands.find((t) => t.kind === 'name');
        const sizeTok = op.operands.find((t) => t.kind === 'number');
        if (nameTok) fontResource = nameTok.name!;
        if (sizeTok) fontSize = sizeTok.num!;
        break;
      }
      case 'Td': { const v = nums(op); tlm = mul(translate(v[0] || 0, v[1] || 0), tlm); tm = tlm; break; }
      case 'TD': { const v = nums(op); tl = -(v[1] || 0); tlm = mul(translate(v[0] || 0, v[1] || 0), tlm); tm = tlm; break; }
      case 'Tm': { const v = nums(op); if (v.length === 6) { tm = v as Mat; tlm = tm; } break; }
      case 'TL': tl = nums(op)[0] || 0; break;
      case 'T*': tlm = mul(translate(0, -tl), tlm); tm = tlm; break;
      case 'Tc': tc = nums(op)[0] || 0; break;
      case 'Tw': tw = nums(op)[0] || 0; break;
      case 'Tz': tz = nums(op)[0] ?? 100; break;
      case 'rg': { const v = nums(op); color = { r: v[0] || 0, g: v[1] || 0, b: v[2] || 0 }; break; }
      case 'g': { const v = nums(op)[0] || 0; color = { r: v, g: v, b: v }; break; }
      case 'k': {
        const v = nums(op); const kk = v[3] || 0;
        color = {
          r: 1 - Math.min(1, (v[0] || 0) + kk),
          g: 1 - Math.min(1, (v[1] || 0) + kk),
          b: 1 - Math.min(1, (v[2] || 0) + kk),
        };
        break;
      }
      case 'Tj': case "'": {
        if (!inText) break;
        const sTok = op.operands.filter((t) => t.kind === 'string').pop();
        if (!sTok) break;
        const info = fonts.get(fontResource);
        showOp(op, splitCodes(sTok.bytes!, info), sTok, 0);
        break;
      }
      case '"': {
        if (!inText) break;
        const sTok = op.operands.filter((t) => t.kind === 'string').pop();
        if (!sTok) break;
        const info = fonts.get(fontResource);
        showOp(op, splitCodes(sTok.bytes!, info), sTok, 0);
        break;
      }
      case 'TJ': {
        if (!inText) break;
        const info = fonts.get(fontResource);
        const arrStart = op.operands.findIndex((t) => t.kind === 'arrayStart');
        const arrEnd = op.operands.findIndex((t) => t.kind === 'arrayEnd');
        if (arrStart < 0 || arrEnd < 0) break;
        const inner = op.operands.slice(arrStart + 1, arrEnd);
        const codes: number[] = [];
        let adj = 0;
        for (const t of inner) {
          if (t.kind === 'string') codes.push(...splitCodes(t.bytes!, info));
          else if (t.kind === 'number') adj += t.num!;
        }
        const operand: Token = { kind: 'string', start: op.operands[arrStart].start, end: op.operands[arrEnd].end };
        showOp(op, codes, operand, adj);
        break;
      }
    }
  }

  return { pageIndex, content, runs, fonts };
}

export async function loadAndExtract(pdfBytes: Uint8Array) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages: PageData[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) pages.push(extractPage(doc, i));
  return { doc, pages };
}
