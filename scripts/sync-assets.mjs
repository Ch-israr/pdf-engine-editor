// Copy runtime assets into public/ so Vite serves and bundles them:
// - the PDF.js worker (version-locked to the pdfjs-dist dependency)
// - the engine's fallback fonts (Liberation, SIL OFL 1.1) from engine/assets
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';

mkdirSync('public/assets/pdfjs', { recursive: true });
mkdirSync('public/assets/fonts', { recursive: true });
copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/assets/pdfjs/pdf.worker.min.mjs');
// PDF.js standard-14 font data + CMaps (needed to render non-embedded
// fonts and CID documents): copied from the pdfjs-dist package.
import { cpSync } from 'node:fs';
cpSync('node_modules/pdfjs-dist/standard_fonts', 'public/assets/standard_fonts', { recursive: true });
cpSync('node_modules/pdfjs-dist/cmaps', 'public/assets/cmaps', { recursive: true });
for (const f of readdirSync('engine/assets')) {
  if (f.endsWith('.ttf')) copyFileSync(`engine/assets/${f}`, `public/assets/fonts/${f}`);
}
console.log('assets synced: pdf.worker.min.mjs + engine fallback fonts');
