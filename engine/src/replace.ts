// The edit pipeline. The safety contract, in order:
//   1. Identify the original run and prove the replacement is writable
//      BEFORE anything is removed (same-font encoding, or fallback-font
//      coverage under the phase script policy).
//   2. Only then modify the content stream.
//   3. Any failure returns the document untouched, with a reason.
import { PDFDocument, PDFFont, PDFName, degrees, rgb } from 'pdf-lib';
import * as fontkit2 from 'fontkit2'; // v2.0.4 — engine-side font reading (wider cmap support)
import { extractPage, type TextRun } from './extract.js';
import { encodeWithFont, stripSubsetPrefix, type FontInfo } from './fonts.js';
import { phaseScriptAllowed } from './winansi.js';

const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
]);

interface EngineFont {
  familyName: string;
  glyphsForString: (s: string) => { id: number }[];
  hasGlyphForCodePoint: (cp: number) => boolean;
}
const programFontCache = new Map<string, EngineFont | null>();
async function programFont(info: FontInfo): Promise<EngineFont | null> {
  const key = `${info.baseName}:${info.embeddedProgram!.length}`;
  if (!programFontCache.has(key)) {
    try {
      const f = await (fontkit2 as never as { create: (b: Uint8Array) => Promise<EngineFont> })
        .create(info.embeddedProgram!);
      programFontCache.set(key, f);
    } catch {
      programFontCache.set(key, null);
    }
  }
  return programFontCache.get(key)!;
}

/**
 * Glyph-presence proof for the same-font path. An encoding entry or a
 * /Widths row is NOT proof that a (subset) font program actually contains
 * the glyph — subsetters routinely keep width rows for glyphs they dropped.
 * Proof, in order of strength:
 *  1. The embedded program itself (fontkit): a real glyph (id != .notdef).
 *  2. Standard-14 fonts: coverage is definitional.
 *  3. Otherwise: the character already appears in this font's runs on the
 *     page — its glyph demonstrably exists in the file.
 */
export async function sameFontProven(info: FontInfo, replacement: string, pageRuns: TextRun[]): Promise<boolean> {
  if (info.embeddedProgram) {
    const pf = await programFont(info);
    if (pf) {
      try {
        for (const ch of replacement) {
          const glyph = pf.glyphsForString(ch)[0];
          if (!glyph || (glyph.id === 0 && ch !== ' ' && ch !== '\t')) return false;
        }
        return true;
      } catch {
        // unreadable cmap: fall through to the proven-chars rule
      }
    }
    // unparseable program: fall through to the proven-chars rule
  } else if (STANDARD_14.has(stripSubsetPrefix(info.baseName))) {
    return true;
  }
  const proven = new Set<string>();
  for (const r of pageRuns) if (r.fontResource === info.resource) for (const ch of r.text) proven.add(ch);
  for (const ch of replacement) if (!proven.has(ch)) return false;
  return true;
}

export type EditOutcome =
  | { ok: true; path: 'same-font' | 'fallback-font'; bytes: Uint8Array; detail: string }
  | { ok: false; reason: string; detail: string };

// Fallback family: Liberation (OFL-1.1), metric-compatible with Arial /
// Times New Roman — the dominant families in real-world documents — with a
// complete Regular/Bold/Italic/BoldItalic matrix for both sans and serif.
// (DejaVu Sans remains bundled from the PoC phase; its local package lacks
// oblique variants, which is why Liberation carries the fallback role.)
export type FallbackKind = 'sans' | 'sans-bold' | 'sans-oblique' | 'sans-boldoblique' | 'serif' | 'serif-bold' | 'serif-oblique' | 'serif-boldoblique';
export const FALLBACK_FILES: Record<FallbackKind, string> = {
  'sans': '../assets/LiberationSans-Regular.ttf',
  'sans-bold': '../assets/LiberationSans-Bold.ttf',
  'sans-oblique': '../assets/LiberationSans-Italic.ttf',
  'sans-boldoblique': '../assets/LiberationSans-BoldItalic.ttf',
  'serif': '../assets/LiberationSerif-Regular.ttf',
  'serif-bold': '../assets/LiberationSerif-Bold.ttf',
  'serif-oblique': '../assets/LiberationSerif-Italic.ttf',
  'serif-boldoblique': '../assets/LiberationSerif-BoldItalic.ttf',
};
const fallbackCache = new Map<FallbackKind, { bytes: Uint8Array; font: EngineFont }>();

/** Pick the fallback variant closest to the original font's family/weight/style. */
export function fallbackKindFor(baseName: string): FallbackKind {
  const n = stripSubsetPrefix(baseName).toLowerCase();
  const serif = /serif|times|georgia|cambria|garamond|book|roman/.test(n) && !/sans/.test(n);
  const bold = /bold|black|heavy|semibold|demibold/.test(n);
  const italic = /italic|oblique/.test(n);
  if (serif) {
    if (bold && italic) return 'serif-boldoblique';
    if (bold) return 'serif-bold';
    if (italic) return 'serif-oblique';
    return 'serif';
  }
  if (bold && italic) return 'sans-boldoblique';
  if (bold) return 'sans-bold';
  if (italic) return 'sans-oblique';
  return 'sans';
}

// --- Host integration points -------------------------------------------------
// The engine core is environment-agnostic. Node hosts (the test suites) get
// the defaults below: fallback fonts read from ../assets with node:fs, and
// pdf-lib is given fontkit 1.8.1 (the only API its subset embedder can
// drive). Browser hosts call configureEngine() to inject font bytes fetched
// over HTTP and fontkit2 (with subsetting disabled, since pdf-lib's subset
// embedder cannot use fontkit 2.x). Engine DECISIONS are identical either
// way; only font byte delivery and the embedder differ.
export interface EngineConfig {
  loadFallbackFontBytes?: (kind: FallbackKind) => Promise<Uint8Array>;
  pdfLibFontkit?: unknown;
  subsetFallbackFont?: boolean;
}
let engineConfig: EngineConfig = {};
export function configureEngine(cfg: EngineConfig): void {
  engineConfig = { ...cfg };
  fallbackCache.clear();
}

async function defaultFallbackBytes(kind: FallbackKind): Promise<Uint8Array> {
  const fs = await import(/* @vite-ignore */ 'node:fs');
  // node Buffer on purpose: pdf-lib's fontkit-1.x subsetting path requires
  // Buffer input (a plain Uint8Array fails its format sniffer).
  return fs.readFileSync(new URL(FALLBACK_FILES[kind], import.meta.url));
}

async function defaultPdfLibFontkit(): Promise<unknown> {
  const fk = await import(/* @vite-ignore */ 'fontkit');
  return (fk as { default?: unknown }).default ?? fk;
}

export async function fallbackFont(kind: FallbackKind) {
  if (!fallbackCache.has(kind)) {
    const bytes = engineConfig.loadFallbackFontBytes
      ? await engineConfig.loadFallbackFontBytes(kind)
      : await defaultFallbackBytes(kind);
    const font = await (fontkit2 as never as { create: (b: Uint8Array) => Promise<EngineFont & { unitsPerEm: number; layout: (s: string) => { glyphs: { advanceWidth: number }[] } }> }).create(bytes);
    fallbackCache.set(kind, { bytes, font });
  }
  return fallbackCache.get(kind)!;
}

/**
 * Register the host fontkit with pdf-lib and embed a prepared fallback
 * font (subset or whole, per host configuration). Shared by the whole-run
 * fallback path and the fragment hybrid path; the calls and their order
 * are exactly the ones the whole-run path has always made.
 */
export async function embedPreparedFallback(
  doc: PDFDocument,
  fb: { bytes: Uint8Array },
): Promise<{ drawFont: PDFFont }> {
  doc.registerFontkit((engineConfig.pdfLibFontkit ?? (await defaultPdfLibFontkit())) as never);
  const embedded = await doc.embedFont(fb.bytes, { subset: engineConfig.subsetFallbackFont ?? true });
  return { drawFont: embedded };
}

export function hexString(bytes: Uint8Array): string {
  let h = '<';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h + '>';
}

export function spliceBytes(data: Uint8Array, start: number, end: number, insert: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length - (end - start) + insert.length);
  out.set(data.subarray(0, start), 0);
  out.set(insert, start);
  out.set(data.subarray(end), start + insert.length);
  return out;
}

const enc = new TextEncoder();

export interface EditRequest {
  pageIndex: number;
  runOrdinal: number;
  matchText: string;
  replacement: string;
}

export async function replaceRunText(pdfBytes: Uint8Array, req: EditRequest): Promise<EditOutcome> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  if (req.pageIndex < 0 || req.pageIndex >= doc.getPageCount()) {
    return { ok: false, reason: 'page-out-of-range', detail: `page ${req.pageIndex} does not exist` };
  }
  const pageData = extractPage(doc, req.pageIndex);
  const run = pageData.runs[req.runOrdinal];
  if (!run) {
    return { ok: false, reason: 'target-not-found', detail: `no text run #${req.runOrdinal} on page ${req.pageIndex + 1} (${pageData.runs.length} runs found)` };
  }
  if (run.operator === "'" || run.operator === '"') {
    // The run exists — never report target-not-found for it. These
    // operators carry an implicit line move and are not editable in this
    // engine (the fragment API refuses them the same way); reject with an
    // accurate reason before any editing path can run.
    return {
      ok: false, reason: 'operator-unsupported',
      detail: `run #${run.ordinal} is shown with the ${run.operator} operator (implicit line move); whole-run replacement supports Tj and TJ runs only — the original text was preserved`,
    };
  }
  if (!run.mappable) {
    return {
      ok: false, reason: 'font-not-mappable',
      detail: `run #${run.ordinal} uses font ${run.fontResource} (${pageData.fonts.get(run.fontResource)?.baseName ?? '?'}) whose glyphs cannot be mapped to Unicode (no usable ToUnicode/encoding) — the original text cannot be identified safely, so nothing was changed`,
    };
  }
  if (run.text !== req.matchText) {
    return {
      ok: false, reason: 'target-mismatch',
      detail: `run #${run.ordinal} contains ${JSON.stringify(run.text)}, not ${JSON.stringify(req.matchText)}`,
    };
  }

  // Phase script policy (English/Latin first) — applies to every path.
  const gate = phaseScriptAllowed(req.replacement);
  if (!gate.ok) {
    return {
      ok: false, reason: 'script-not-supported-in-this-phase',
      detail: `replacement contains characters outside the Latin phase-1 scope: ${gate.bad.map((c) => JSON.stringify(c)).join(' ')} — original text preserved`,
    };
  }

  const info = pageData.fonts.get(run.fontResource)!;
  const page = doc.getPage(req.pageIndex);

  // --- Path A: rewrite the shown string in the SAME font -------------------
  const encoded = encodeWithFont(info, req.replacement);
  if (encoded && (await sameFontProven(info, req.replacement, pageData.runs))) {
    const newContent = spliceBytes(
      pageData.content, run.operandStart, run.opEnd,
      enc.encode(`${hexString(encoded)} Tj`),
    );
    const ref = doc.context.register(doc.context.flateStream(newContent));
    page.node.set(PDFName.of('Contents'), ref);
    return {
      ok: true, path: 'same-font',
      detail: `rewrote the run in its original font ${info.baseName} (${info.subtype})`,
      bytes: await doc.save(),
    };
  }

  // --- Path B: remove the run, redraw with an embedded fallback font ------
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
  const stripped = spliceBytes(pageData.content, run.opStart, run.opEnd, enc.encode('%poc-run-removed'));
  const ref = doc.context.register(doc.context.flateStream(stripped));
  page.node.set(PDFName.of('Contents'), ref);
  const { drawFont: embedded } = await embedPreparedFallback(doc, fb);
  // Width bookkeeping: PDF has no reflow, so a wider replacement can reach
  // into following content. Report both widths so callers (the future
  // editor UI) can warn instead of the engine silently overlapping text.
  const layoutFont = fb.font as EngineFont & { unitsPerEm: number; layout: (s: string) => { glyphs: { advanceWidth: number }[] } };
  const layoutWidth = (s: string) => layoutFont.layout(s).glyphs.reduce((a, g) => a + g.advanceWidth, 0) / layoutFont.unitsPerEm * run.fontSize;
  // Prefer the run font's own /Widths; when they are incomplete (e.g.
  // Standard-14 documents carry no /Widths array), estimate with the same
  // fallback instrument as the after-width so the delta stays meaningful.
  const widthsComplete = run.codes.every((code) => info.widths.has(code));
  const widthBefore = widthsComplete
    ? run.codes.reduce((a, code) => a + info.widths.get(code)!, 0) / 1000 * run.fontSize
    : layoutWidth(run.text);
  const widthAfter = layoutWidth(req.replacement);
  page.drawText(req.replacement, {
    x: run.x, y: run.y,
    size: run.fontSize,
    font: embedded,
    color: rgb(run.color.r, run.color.g, run.color.b),
    ...(Math.abs(run.angleDeg) >= 0.5 ? { rotate: degrees(run.angleDeg) } : {}),
  });
  return {
    ok: true, path: 'fallback-font',
    detail: `original font ${info.baseName} (${info.subtype}) cannot write the replacement; removed the run and redrew it with an embedded ${(engineConfig.subsetFallbackFont ?? true) ? 'subset' : 'copy'} of ${fb.font.familyName} (${kind}) at the original position, size, colour${Math.abs(run.angleDeg) >= 0.5 ? ` and rotation (${run.angleDeg.toFixed(1)}°)` : ''}; width ${widthBefore.toFixed(1)}pt -> ${widthAfter.toFixed(1)}pt`,
    bytes: await doc.save(),
  };
}
