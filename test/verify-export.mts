// Verify the PDF the browser exported during the E2E: it must parse with
// the engine, contain the edit, and retain the rest of the document.
import { readFile } from 'node:fs/promises';
import { loadAndExtract } from '../engine/src/extract';

const bytes = new Uint8Array(await readFile('test/out/e2e-export.pdf'));
const { pages } = await loadAndExtract(bytes);
const all = pages.flatMap((p) => p.runs.map((r) => r.text));
const ok = all.some((t) => t.includes('RED')) && !all.some((t) => t.includes('BROWN')) && pages.length === 3
  && all.some((t) => t.includes('français'));
console.log(`export check: pages=${pages.length} RED=${all.some((t) => t.includes('RED'))} BROWN-gone=${!all.some((t) => t.includes('BROWN'))} french-intact=${all.some((t) => t.includes('français'))}`);
if (!ok) { console.error('EXPORT VERIFICATION FAILED'); process.exit(1); }
console.log('EXPORT VERIFIED');
