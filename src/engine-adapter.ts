// The ONLY module that talks to the vendored engine. It configures the
// engine for the browser exactly as validated in the research lab:
// fallback fonts are fetched from the app's own static assets, pdf-lib is
// driven by fontkit 2.x, and fallback fonts are embedded whole (pdf-lib's
// subset embedder cannot use fontkit 2.x). Engine decisions are identical
// to the Node build; no document data ever leaves the browser.
import * as fontkit2 from 'fontkit2';
import { loadAndExtract, type PageData, type TextRun } from '../engine/src/extract';
import {
  measureFragmentReplacement, replaceFragmentInRun,
  type FragmentMeasure, type FragmentRequest,
} from '../engine/src/fragment';
import {
  configureEngine, FALLBACK_FILES, measureReplacement, replaceRunText,
  type EditOutcome, type ReplacementMeasure,
} from '../engine/src/replace';

let configured = false;

export function initEngine(): void {
  if (configured) return;
  configured = true;
  configureEngine({
    loadFallbackFontBytes: async (kind) => {
      const file = FALLBACK_FILES[kind].split('/').pop()!;
      const res = await fetch(`assets/fonts/${file}`);
      if (!res.ok) throw new Error(`fallback font ${file} failed to load (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    pdfLibFontkit: fontkit2,
    subsetFallbackFont: false,
  });
}

export interface ExtractedDocument {
  pages: PageData[];
  pageCount: number;
}

export async function extractDocument(bytes: Uint8Array): Promise<ExtractedDocument> {
  initEngine();
  const { doc, pages } = await loadAndExtract(bytes);
  return { pages, pageCount: doc.getPageCount() };
}

export async function applyWholeRun(bytes: Uint8Array, pageIndex: number, runOrdinal: number, matchText: string, replacement: string): Promise<EditOutcome> {
  initEngine();
  return replaceRunText(bytes, { pageIndex, runOrdinal, matchText, replacement });
}

export async function applyFragment(bytes: Uint8Array, req: Omit<FragmentRequest, never>): Promise<EditOutcome> {
  initEngine();
  return replaceFragmentInRun(bytes, req);
}

// Read-only width/path estimates for the inline editor's width warning.
// They operate on the already-extracted page data (no document reload)
// and mirror the engine's own gates and numbers; they never modify bytes.
export async function measureWholeRun(pageData: PageData, run: TextRun, replacement: string): Promise<ReplacementMeasure> {
  initEngine();
  return measureReplacement(pageData, run, replacement);
}

export async function measureFragment(pageData: PageData, run: TextRun, start: number, end: number, replacement: string): Promise<FragmentMeasure> {
  initEngine();
  return measureFragmentReplacement(pageData, run, start, end, replacement);
}

export type { EditOutcome, FragmentMeasure, FragmentRequest, PageData, ReplacementMeasure, TextRun };
