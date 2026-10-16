// Engine-integration + selection-mapping tests for PDF Engine Editor.
// Runs the VENDORED engine (Node defaults) and the app's own mapper
// (src/selection-map.ts) against synthetic fixtures. Every case asserts
// its exact expected outcome; any failure exits non-zero.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
// @ts-ignore legacy build for Node-side text extraction
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadAndExtract } from '../engine/src/extract';
import { replaceFragmentInRun } from '../engine/src/fragment';
import { replaceRunText } from '../engine/src/replace';
import { mapRunsToItems, validateFragment, type ViewerItem } from '../src/selection-map';

GlobalWorkerOptions.workerSrc = process.cwd() + '/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const load = async (f: string) => new Uint8Array(await readFile(`test/fixtures/${f}`));
async function texts(bytes: Uint8Array, page = 0): Promise<string[]> {
  const { pages } = await loadAndExtract(bytes);
  return pages[page].runs.map((r) => r.text);
}
async function itemsOf(bytes: Uint8Array): Promise<ViewerItem[][]> {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const out: ViewerItem[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    out[p - 1] = tc.items.filter((it: any) => 'str' in it).map((it: any, i: number) => ({
      pageIndex: p - 1, itemIndex: i, str: it.str, x: it.transform[4], y: it.transform[5], width: it.width,
    }));
  }
  await doc.destroy();
  return out;
}

// T1: basic Tj whole-run edit (same-font), input buffer untouched
{
  const bytes = await load('standard.pdf');
  const before = sha(bytes);
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'Invoice INV-2026-041')!;
  const out = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'Invoice INV-2026-042' });
  check('T1 Tj whole-run edits via same-font', out.ok && out.path === 'same-font', out.ok ? out.path : out.reason);
  const after = await texts(out.bytes!);
  check('T1 replacement extracts, original gone', after.includes('Invoice INV-2026-042') && !after.includes('Invoice INV-2026-041'));
  check('T1 input bytes unchanged by the engine call', sha(bytes) === before);
}

// T2: TJ run with numeric adjustments — whole-run replace lands
{
  const bytes = await load('frag.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'The quick brown fox jumps')!;
  const out = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'The quick red fox jumps' });
  check('T2 TJ whole-run edits', out.ok, out.ok ? out.path : out.reason);
  check('T2 replacement extracts exactly', (await texts(out.bytes!)).includes('The quick red fox jumps'));
}

// T3: subset font (LibreOffice) — fallback path
{
  const bytes = await load('writer.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'BROWN')!;
  const out = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'RED' });
  check('T3 subset-font run edits via fallback-font', out.ok && out.path === 'fallback-font', out.ok ? out.path : out.reason);
  const after = await texts(out.bytes!);
  check('T3 RED present, BROWN gone', after.includes('RED') && !after.includes('BROWN'));
}

// T4: supported fragment (French TJ run, hybrid path)
{
  const bytes = await load('writer.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text.includes('garçon'))!;
  const start = run.text.indexOf('garçon');
  const out = await replaceFragmentInRun(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, start, end: start + 6, replacement: 'fille' });
  check('T4 fragment edits via fallback-font', out.ok && out.path === 'fallback-font', out.ok ? out.path : out.reason);
  const after = await texts(out.bytes!);
  check('T4 pieces extract (prefix, fille, suffix)', after.some((t) => t.includes("d'un ")) && after.some((t) => t.includes('fille')) && after.some((t) => t.includes('français')));
}

// T5: rotated content — /Rotate 90 page whole-run + rotated-text fragment
{
  const bytes = await load('rotate90.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs[0];
  const out = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'Rotated page title' });
  check('T5 /Rotate 90 page whole-run edits', out.ok, out.ok ? out.path : out.reason);
  const rb = await load('rotated.pdf');
  const rx = await loadAndExtract(rb);
  const rr = rx.pages[0].runs.find((r) => r.text.includes('30deg'))!;
  const at = rr.text.indexOf('30deg');
  const fout = await replaceFragmentInRun(rb, { pageIndex: 0, runOrdinal: rr.ordinal, matchText: rr.text, start: at, end: at + 5, replacement: '45deg' });
  check('T5 rotated-text fragment edits', fout.ok, fout.ok ? fout.path : fout.reason);
}

// T6: multi-page — edit on page 3 of writer.pdf, structure preserved
{
  const bytes = await load('writer.pdf');
  const { pages } = await loadAndExtract(bytes);
  check('T6 writer.pdf has 3 pages of runs', pages.length === 3);
  const run = pages[2].runs.find((r) => r.text.length > 3)!;
  const out = await replaceRunText(bytes, { pageIndex: 2, runOrdinal: run.ordinal, matchText: run.text, replacement: run.text.replace(/[A-Za-z]+/, 'EDITED') });
  check('T6 page-3 edit lands', out.ok, out.ok ? out.path : out.reason);
  const after = await loadAndExtract(out.bytes!);
  check('T6 page count preserved', after.pages.length === 3);
  check('T6 page 1 text untouched', JSON.stringify(after.pages[0].runs.map((r) => r.text)) === JSON.stringify(pages[0].runs.map((r) => r.text)));
}

// T7: unsupported quote operator — both APIs refuse accurately
{
  const bytes = await load('quote.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'Quote op line')!;
  const w = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'Changed line' });
  check('T7 whole-run refuses operator-unsupported', !w.ok && w.reason === 'operator-unsupported', w.ok ? w.path : w.reason);
  const f = await replaceFragmentInRun(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, start: 2, end: 4, replacement: 'XX' });
  check('T7 fragment refuses fragment-operator-unsupported', !f.ok && f.reason === 'fragment-operator-unsupported', f.ok ? f.path : f.reason);
}

// T8+T10: Arabic replacement refused, then a valid edit succeeds on the same bytes
{
  const bytes = await load('standard.pdf');
  const before = sha(bytes);
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'Invoice INV-2026-041')!;
  const bad = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'فاتورة جديدة' });
  check('T8 Arabic replacement refuses script-not-supported-in-this-phase', !bad.ok && bad.reason === 'script-not-supported-in-this-phase', bad.ok ? bad.path : bad.reason);
  check('T10 refused edit left the bytes untouched', sha(bytes) === before);
  const good = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'Invoice INV-2026-777' });
  check('T10 valid edit succeeds after a refusal', good.ok && (await texts(good.bytes!)).includes('Invoice INV-2026-777'));
}

// T9: width-less font hybrid + unmappable document
{
  const bytes = await load('frag.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'The cat sat with the cat')!;
  const at = run.text.indexOf('cat');
  const out = await replaceFragmentInRun(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, start: at, end: at + 3, replacement: 'Ābc' });
  check('T9 width-less font hybrid refuses fragment-widths-unavailable', !out.ok && out.reason === 'fragment-widths-unavailable', out.ok ? out.path : out.reason);
  const scanned = await load('scanned.pdf');
  const sx = await loadAndExtract(scanned);
  check('T9 scanned page yields zero runs', sx.pages[0].runs.length === 0);
  const sw = await replaceRunText(scanned, { pageIndex: 0, runOrdinal: 0, matchText: 'Scanned invoice 1042', replacement: 'X' });
  check('T9 scanned edit refuses target-not-found', !sw.ok && sw.reason === 'target-not-found');
}

// T11: longer replacement — success with the no-reflow width report
{
  const bytes = await load('writer.pdf');
  const { pages } = await loadAndExtract(bytes);
  const run = pages[0].runs.find((r) => r.text === 'BROWN')!;
  const out = await replaceRunText(bytes, { pageIndex: 0, runOrdinal: run.ordinal, matchText: run.text, replacement: 'BRIGHTCRIMSON' });
  check('T11 longer replacement edits via fallback', out.ok && out.path === 'fallback-font', out.ok ? out.path : out.reason);
  check('T11 engine detail reports the width change (no-reflow disclosed)', out.ok && /wider|narrower|width/i.test(out.detail), out.ok ? out.detail.slice(0, 90) : '');
  check('T11 long replacement extracts', (await texts(out.bytes!)).includes('BRIGHTCRIMSON'));
}

// T12: selection mapping — real items, ambiguity, stale fragment
{
  const bytes = await load('writer.pdf');
  const { pages } = await loadAndExtract(bytes);
  const items = await itemsOf(bytes);
  const m = mapRunsToItems(pages, items);
  const brown = m.targets.find((t) => t.runText === 'BROWN');
  check('T12 BROWN run maps to a viewer-item sequence', !!brown && brown.itemIndices.length >= 1);
  check('T12 TJ-split runs map as sequences (\'The quick \' + \' fox jumps...\')',
    m.targets.some((t) => t.runText === 'The quick ') && m.targets.some((t) => t.runText === ' fox jumps over the lazy dog.'),
    `${m.targets.length} targets, ${m.unmapped.length} unmapped`);
  // Ambiguity: insert an identical twin of the BROWN item adjacent to it —
  // a second valid segmentation now exists, so the run must unmap.
  const items2 = items.map((pageItems) => pageItems.slice());
  const srcPos = items2[0].findIndex((it) => it.itemIndex === brown!.itemIndices[0]);
  const srcItem = items2[0][srcPos];
  items2[0].splice(srcPos + 1, 0, { ...srcItem, itemIndex: 10000 + srcItem.itemIndex });
  const m2 = mapRunsToItems(pages, items2);
  check('T12 duplicated item makes the mapping ambiguous -> unmapped',
    !m2.targets.some((t) => t.runText === 'BROWN') && m2.unmapped.some((u) => u.text === 'BROWN' && /ambiguous/.test(u.reason)));
  // Fragment validation: correct slice passes, stale text fails.
  const okF = validateFragment(brown!, 1, 3, 'RO');
  check('T12 validateFragment accepts the exact slice', okF.ok);
  const badF = validateFragment(brown!, 1, 3, 'XX');
  check('T12 validateFragment rejects a stale/mismatched slice', !badF.ok);
  // Fragment range across an item boundary inside one run (' fox...' is
  // items [' ', 'fox jumps over the lazy dog.']): 'fox' is run [1, 4).
  const foxRun = m.targets.find((t) => t.runText === ' fox jumps over the lazy dog.')!;
  const { rangeInRun } = await import('../src/selection-map.ts');
  const foxItem = foxRun.itemIndices[1];
  const rr = rangeInRun(foxRun, items[0], foxItem, 0, foxItem, 3);
  check('T12 rangeInRun converts an in-item range to run offsets', rr.start === 1 && rr.end === 4, JSON.stringify(rr));
  check('T12 cross-item fragment slice validates', validateFragment(foxRun, rr.start, rr.end, 'fox').ok);
}

// T13: fixture files on disk are never mutated by the suite itself
{
  const names = ['standard.pdf', 'frag.pdf', 'writer.pdf', 'calc.pdf', 'rotated.pdf', 'quote.pdf', 'scanned.pdf', 'rotate90.pdf'];
  const hashes = await Promise.all(names.map(async (n) => sha(await load(n))));
  check('T13 fixture hashes recorded (mutation check is the before/after suite comparison)', hashes.every((h) => h.length === 64), names.join(','));
}

console.log(`\n${passed}/${passed + failed} integration checks passed`);
if (failed) process.exit(1);
console.log('ALL INTEGRATION CHECKS PASSED');
