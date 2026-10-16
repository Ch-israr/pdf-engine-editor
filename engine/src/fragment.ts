// Fragment-level editing: replace a character range inside ONE text run,
// leaving the rest of the run (and the document) in place.
//
// Safety contract (same as the whole-run pipeline):
//   1. Identify the run and prove the fragment mapping (character range ->
//      operator codes) and the replacement's writability BEFORE modifying.
//   2. Path A (same-font): splice the replacement codes into the run's own
//      show operator (Tj string or TJ array, preserving the TJ spacing
//      adjustments outside the fragment). The suffix follows the replacement
//      inside the same operator and shifts by exactly the width delta.
//   3. Path B' (hybrid fallback): prefix and suffix stay in the original
//      font as in-stream show ops; a Td compensation moves the pen across
//      the fragment's exact original advance, so the suffix keeps its exact
//      original position; the replacement alone is drawn with the embedded
//      fallback font at the fragment's measured origin (rotation honoured).
//   4. Anything unprovable returns a precise reason; the document is never
//      modified on a failure path.
import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';
import { extractPage, type PageData, type TextRun } from './extract.js';
import { encodeWithFont, type FontInfo } from './fonts.js';
import { tokenize } from './content.js';
import { phaseScriptAllowed } from './winansi.js';
import {
  embedPreparedFallback, fallbackFont, fallbackKindFor, hexString,
  replaceRunText, sameFontProven, spliceBytes, type EditOutcome,
} from './replace.js';

export interface FragmentRequest {
  pageIndex: number;
  runOrdinal: number;
  matchText: string;   // the run's full current text (integrity check)
  start: number;       // character offset into run.text (UTF-16 units)
  end: number;         // exclusive
  replacement: string;
}

const enc = new TextEncoder();
const fmtNum = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
const codesToBytes = (codes: number[], isCID: boolean): Uint8Array => {
  if (!isCID) return new Uint8Array(codes);
  const out = new Uint8Array(codes.length * 2);
  codes.forEach((c, i) => { out[i * 2] = (c >> 8) & 0xff; out[i * 2 + 1] = c & 0xff; });
  return out;
};

// ---------------------------------------------------------------------------
// Operand model: the exact relationship between the run's codes and the
// numbers/strings of its show operator. gapAt[p] is the TJ adjustment that
// sits immediately before code p (gapAt[0] = leading numbers, gapAt[len] =
// trailing numbers). All advances below use the walker's own formula.
// ---------------------------------------------------------------------------
interface OperandModel {
  gapAt: number[]; // length codes.length + 1
}

function buildOperandModel(pageData: PageData, run: TextRun): OperandModel | null {
  const operandBytes = pageData.content.subarray(run.operandStart, run.operandEnd);
  const tokens = tokenize(operandBytes);
  const info = pageData.fonts.get(run.fontResource)!;
  const gapAt = new Array(run.codes.length + 1).fill(0);
  let codePos = 0;
  let pending = 0; // numbers seen since the last string
  let sawString = false;
  for (const t of tokens) {
    if (t.kind === 'number') { pending += t.num!; continue; }
    if (t.kind === 'string') {
      gapAt[codePos] += pending; pending = 0; sawString = true;
      const codes = info.isCID
        ? Array.from({ length: Math.floor(t.bytes!.length / 2) }, (_, i) => (t.bytes![i * 2] << 8) | t.bytes![i * 2 + 1])
        : [...t.bytes!];
      for (const c of codes) {
        if (run.codes[codePos] !== c) return null; // operand disagrees with extraction
        codePos++;
      }
    }
  }
  gapAt[run.codes.length] += pending;
  if (!sawString || codePos !== run.codes.length) return null;
  return { gapAt };
}

function codeAdvance(info: FontInfo, run: TextRun, code: number): number {
  const w = info.widths.get(code) ?? (info.isCID ? info.defaultWidth : 0);
  let a = (w / 1000) * run.fontSize * (run.hScale / 100);
  a += run.charSpacing;
  if (!info.isCID && info.codeToUnicode.get(code) === ' ') a += run.wordSpacing;
  return a;
}

/** Text-position advance from the run origin to the start of code `pos`,
 *  following the walker's model exactly (widths, Tc, Tw, Tz, TJ numbers).
 *  gapAt[len] is the TRAILING adjustment (after the last code): it is not
 *  part of reaching any code's start, so it is excluded here; callers that
 *  need the run's total advance add it back explicitly. */
function advanceUpTo(model: OperandModel, info: FontInfo, run: TextRun, pos: number): number {
  let adv = 0;
  for (let i = 0; i < pos; i++) adv += codeAdvance(info, run, run.codes[i]);
  const lastGap = pos === run.codes.length ? pos - 1 : pos;
  for (let p = 0; p <= lastGap; p++) adv += (-model.gapAt[p] / 1000) * run.fontSize;
  return adv;
}

/** Build a show operator covering codes [from, to) of the run, preserving
 *  the TJ adjustments strictly inside the range. When insertCodes is given,
 *  they are emitted at code position `insertAt` (which must lie in
 *  [from, to]) in place of the codes from insertAt to `skipTo`. A TJ build
 *  may carry a leadAdjust: a pen-relative shift emitted as the array's
 *  first number (the reliable way to move the pen — Td is relative to the
 *  line matrix, not to the pen, so it must not be used mid-line). */
function buildShowOp(
  model: OperandModel, info: FontInfo, run: TextRun,
  from: number, to: number,
  insertAt = -1, insertCodes: number[] | null = null, skipTo = -1,
  leadAdjust = 0,
): string {
  const isTJ = run.operator === 'TJ';
  type Part = { codes: number[] } | { num: number };
  const parts: Part[] = [];
  if (isTJ && leadAdjust !== 0) parts.push({ num: leadAdjust });
  // A leading adjustment (numbers before the first string) belongs to the
  // run itself; a build covering the run's start must re-emit it or the
  // whole line shifts. (Regression: FG1/FG5 dropped it.)
  if (isTJ && from === 0 && model.gapAt[0] !== 0) parts.push({ num: model.gapAt[0] });
  let buf: number[] = [];
  const flush = () => {
    if (buf.length) { parts.push({ codes: buf }); buf = []; }
  };
  let i = from;
  while (i < to) {
    if (i === insertAt && insertCodes) {
      flush();
      // The boundary gap is emitted here only when codes are actually
      // being replaced/removed; for a pure insertion the loop reaches the
      // same position again and emits it there — exactly once either way.
      // (Regression: FG6 emitted it twice.)
      if (skipTo !== i && model.gapAt[i] !== 0) parts.push({ num: model.gapAt[i] });
      if (insertCodes.length) parts.push({ codes: insertCodes });
      i = skipTo;
      insertAt = -1;
      continue;
    }
    if (i > from && model.gapAt[i] !== 0) { flush(); parts.push({ num: model.gapAt[i] }); }
    buf.push(run.codes[i]);
    i++;
  }
  flush();
  // A trailing TJ adjustment belongs to the full run; keep it when this
  // build covers the run's end.
  if (isTJ && to === run.codes.length && model.gapAt[to] !== 0) parts.push({ num: model.gapAt[to] });
  if (!isTJ) {
    // A Tj has no adjustment numbers: every chunk merges into one string.
    const merged: number[] = [];
    for (const p of parts) if ('codes' in p) merged.push(...p.codes);
    return `${hexString(codesToBytes(merged, info.isCID))} Tj`;
  }
  return `[${parts.map((p) => ('codes' in p ? hexString(codesToBytes(p.codes, info.isCID)) : fmtNum(p.num))).join(' ')}] TJ`;
}

// ---------------------------------------------------------------------------
export async function replaceFragmentInRun(pdfBytes: Uint8Array, req: FragmentRequest): Promise<EditOutcome> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  if (req.pageIndex < 0 || req.pageIndex >= doc.getPageCount()) {
    return { ok: false, reason: 'page-out-of-range', detail: `page ${req.pageIndex} does not exist` };
  }
  const pageData = extractPage(doc, req.pageIndex);
  const run = pageData.runs[req.runOrdinal];
  if (!run) {
    return { ok: false, reason: 'target-not-found', detail: `no text run #${req.runOrdinal} on page ${req.pageIndex + 1} (${pageData.runs.length} runs found)` };
  }
  if (!run.mappable) {
    return {
      ok: false, reason: 'font-not-mappable',
      detail: `run #${run.ordinal} uses font ${run.fontResource} whose glyphs cannot be mapped to Unicode — fragment boundaries cannot be identified safely, so nothing was changed`,
    };
  }
  if (run.text !== req.matchText) {
    return { ok: false, reason: 'target-mismatch', detail: `run #${run.ordinal} contains ${JSON.stringify(run.text)}, not ${JSON.stringify(req.matchText)}` };
  }
  if (!Number.isInteger(req.start) || !Number.isInteger(req.end) || req.start < 0 || req.end < req.start || req.end > run.text.length) {
    return {
      ok: false, reason: 'fragment-range-invalid',
      detail: `range [${req.start}, ${req.end}) is outside the run's text (length ${run.text.length})`,
    };
  }
  if (run.operator === "'" || run.operator === '"') {
    return {
      ok: false, reason: 'fragment-operator-unsupported',
      detail: `run #${run.ordinal} uses the ${run.operator} operator (implicit line move); fragment editing supports Tj and TJ runs — whole-run replacement remains available`,
    };
  }

  // Character offsets -> code offsets. A code may decode to several
  // characters (e.g. a ligature code in ToUnicode); a range boundary may
  // not fall inside such a code.
  const info = pageData.fonts.get(run.fontResource)!;
  const perCodeStr = run.codes.map((c) => info.toUnicode?.get(c) ?? info.codeToUnicode.get(c) ?? '');
  const toCodePos = (charPos: number): number | null => {
    if (charPos === run.text.length) return run.codes.length;
    // boundary is valid only if it coincides with a code start
    let acc = 0;
    for (let ci = 0; ci < perCodeStr.length; ci++) {
      if (acc === charPos) return ci;
      acc += perCodeStr[ci].length;
      if (acc > charPos) return null;
    }
    return acc === charPos ? perCodeStr.length : null;
  };
  const codeStart = toCodePos(req.start);
  const codeEnd = toCodePos(req.end);
  if (codeStart === null || codeEnd === null) {
    return {
      ok: false, reason: 'fragment-boundary-in-glyph',
      detail: `the range boundary falls inside a character that the font stores as a single code (e.g. a ligature) — choose a boundary between stored characters`,
    };
  }

  // A whole-run range is exactly the established whole-run operation.
  if (codeStart === 0 && codeEnd === run.codes.length) {
    return replaceRunText(pdfBytes, {
      pageIndex: req.pageIndex, runOrdinal: req.runOrdinal, matchText: req.matchText, replacement: req.replacement,
    });
  }

  const gate = phaseScriptAllowed(req.replacement);
  if (!gate.ok) {
    return {
      ok: false, reason: 'script-not-supported-in-this-phase',
      detail: `replacement contains characters outside the Latin phase-1 scope: ${gate.bad.map((c) => JSON.stringify(c)).join(' ')} — original text preserved`,
    };
  }

  const model = buildOperandModel(pageData, run);
  if (!model) {
    return {
      ok: false, reason: 'fragment-operand-mismatch',
      detail: `run #${run.ordinal}'s operator content does not match its extracted codes — refusing to edit what cannot be mapped exactly`,
    };
  }
  // Cross-check the model against the walker's own replay: the model's
  // total advance must reproduce the run's recorded advance.
  const modelTotal = advanceUpTo(model, info, run, run.codes.length) + (-model.gapAt[run.codes.length] / 1000) * run.fontSize;
  if (Math.abs(modelTotal - run.advancePt) > 0.75) {
    return {
      ok: false, reason: 'fragment-operand-mismatch',
      detail: `advance model mismatch for run #${run.ordinal} (model ${modelTotal.toFixed(2)}pt vs measured ${run.advancePt.toFixed(2)}pt) — refusing`,
    };
  }

  const page = doc.getPage(req.pageIndex);
  const fragAdvance = advanceUpTo(model, info, run, codeEnd) - advanceUpTo(model, info, run, codeStart);
  // Advances are only REAL when the font declares widths for every code in
  // the run; some producers (e.g. pdf-lib Standard-14 output) declare none.
  const widthsComplete = info.isCID || run.codes.every((c) => info.widths.has(c));

  // --- Path A: splice the replacement into the run's own operator ---------
  const encoded = encodeWithFont(info, req.replacement);
  if (encoded && (await sameFontProven(info, req.replacement, pageData.runs))) {
    const replCodes = [...encoded]; // simple fonts: one byte per code
    const newOp = buildShowOp(model, info, run, 0, run.codes.length, codeStart, replCodes, codeEnd);
    // Newlines around the insert: producers may butt the operand directly
    // against the preceding operator (e.g. "Tf<...>"), relying on the
    // operand itself as the token separator — never let the replacement
    // text fuse with neighbouring tokens.
    const newContent = spliceBytes(pageData.content, run.operandStart, run.opEnd, enc.encode(`\n${newOp}\n`));
    const ref = doc.context.register(doc.context.flateStream(newContent));
    page.node.set(PDFName.of('Contents'), ref);
    const replAdvance = replCodes.reduce((a, c) => a + codeAdvance(info, run, c), 0);
    const widthNote = widthsComplete
      ? `fragment advance ${fragAdvance.toFixed(1)}pt -> ${replAdvance.toFixed(1)}pt; the run's suffix follows the replacement inside the same operator (shift ${(replAdvance - fragAdvance).toFixed(1)}pt)`
      : 'this font declares no /Widths, so the width change is not measurable from the file (the splice itself needs no widths)';
    return {
      ok: true, path: 'same-font',
      detail: `fragment [${req.start}, ${req.end}) of run #${run.ordinal} replaced in its original font ${info.baseName} (${info.subtype}); ${widthNote}; surrounding runs untouched`,
      bytes: await doc.save(),
    };
  }

  // --- Path B': hybrid — prefix/suffix stay, replacement redrawn ----------
  if (!widthsComplete) {
    return {
      ok: false, reason: 'fragment-widths-unavailable',
      detail: `font ${info.baseName} declares no usable /Widths for this run's characters, so the fragment's position and the suffix's preserved position cannot be computed exactly — refusing rather than guessing positions (whole-run replacement does not need them and remains available)`,
    };
  }
  const kind = fallbackKindFor(info.baseName);
  const fb = await fallbackFont(kind);
  for (const ch of req.replacement) {
    if (!fb.font.hasGlyphForCodePoint(ch.codePointAt(0)!)) {
      return {
        ok: false, reason: 'glyph-not-covered',
        detail: `character ${JSON.stringify(ch)} is not covered by the fallback font and cannot be written in ${info.baseName} — original text preserved`,
      };
    }
  }
  if (run.hScale !== 100) {
    return {
      ok: false, reason: 'fragment-layout-state-unsupported',
      detail: `run #${run.ordinal} is shown with horizontal scaling Tz=${run.hScale}%; the hybrid path's pen compensation is specified for unscaled text — refusing rather than misplacing the suffix (same-font fragment edits and whole-run replacement are unaffected)`,
    };
  }
  // Pen compensation across the removed fragment. This MUST be pen-relative:
  // a TJ adjustment number shifts the pen by (-n/1000) * fontSize from
  // wherever it currently is. (Td would be wrong here — it is relative to
  // the line matrix, which showing text does not move; using it placed the
  // suffix back near the line start in early testing.)
  // When a prefix exists, the boundary adjustment between prefix and
  // fragment (gapAt[codeStart]) is part of the walker's advance to the
  // fragment, but the rebuilt prefix operator does not re-emit it — so the
  // compensation must carry it, or the suffix lands short by that amount.
  // (Regression: FG5 was short by 175/1000 * 16pt = 2.8pt.)
  const compNum = (Math.abs(fragAdvance) > 0.0001 ? -fragAdvance * 1000 / run.fontSize : 0)
    + (codeStart > 0 ? model.gapAt[codeStart] : 0);
  const trailingNum = codeEnd === run.codes.length ? model.gapAt[run.codes.length] : 0;
  const prefixOp = codeStart > 0 ? buildShowOp(model, info, run, 0, codeStart) : '';
  const parts: string[] = [];
  if (prefixOp) parts.push(prefixOp);
  if (codeEnd < run.codes.length) {
    // Suffix present: fold the compensation into the suffix operator when
    // it is a TJ; for a Tj suffix, emit it as a number-only TJ first.
    if (run.operator === 'TJ') {
      parts.push(buildShowOp(model, info, run, codeEnd, run.codes.length, -1, null, -1, compNum));
    } else {
      if (compNum !== 0) parts.push(`[${fmtNum(compNum)}] TJ`);
      parts.push(buildShowOp(model, info, run, codeEnd, run.codes.length));
    }
  } else if (compNum !== 0 || trailingNum !== 0) {
    // No suffix: still restore the pen to where the original operator left
    // it (compensation + any trailing TJ adjustment), so following
    // relative-positioned content in the same block is unaffected.
    parts.push(`[${fmtNum(compNum + trailingNum)}] TJ`);
  }
  const newContent = spliceBytes(pageData.content, run.opStart, run.opEnd, enc.encode(`\n${parts.join('\n')}\n`));
  const ref = doc.context.register(doc.context.flateStream(newContent));
  page.node.set(PDFName.of('Contents'), ref);

  let replAdvance = 0;
  if (req.replacement.length > 0) {
    const { drawFont } = await embedPreparedFallback(doc, fb);
    const layoutFont = fb.font as typeof fb.font & { unitsPerEm: number; layout: (s: string) => { glyphs: { advanceWidth: number }[] } };
    replAdvance = layoutFont.layout(req.replacement).glyphs.reduce((a, g) => a + g.advanceWidth, 0) / layoutFont.unitsPerEm * run.fontSize;
    // Fragment origin: run origin + the walker's own advance vector.
    let vx: number, vy: number;
    if (run.advancePt > 0.01) {
      vx = (run.endX - run.x) / run.advancePt;
      vy = (run.endY - run.y) / run.advancePt;
    } else {
      const rad = (run.angleDeg * Math.PI) / 180;
      vx = Math.cos(rad); vy = Math.sin(rad);
    }
    const advBefore = advanceUpTo(model, info, run, codeStart);
    page.drawText(req.replacement, {
      x: run.x + vx * advBefore, y: run.y + vy * advBefore,
      size: run.fontSize,
      font: drawFont,
      color: rgb(run.color.r, run.color.g, run.color.b),
      ...(Math.abs(run.angleDeg) >= 0.5 ? { rotate: degrees(run.angleDeg) } : {}),
    });
  }
  return {
    ok: true, path: 'fallback-font',
    detail: `fragment [${req.start}, ${req.end}) of run #${run.ordinal} replaced: prefix and suffix preserved in the original font ${info.baseName} (${info.subtype}) with the suffix at its exact original position; the fragment was redrawn with the embedded fallback font ${fb.font.familyName} (${kind}); fragment advance ${fragAdvance.toFixed(1)}pt -> replacement ${replAdvance.toFixed(1)}pt${Math.abs(run.angleDeg) >= 0.5 ? `; rotation ${run.angleDeg.toFixed(1)}° honoured` : ''}`,
    bytes: await doc.save(),
  };
}
