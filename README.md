# PDF Engine Editor

A browser-local PDF text editor built on the standalone TypeScript PDF
text-editing engine. **Documents never leave the device**: there is no
backend, no upload, no accounts, and no analytics. All parsing, editing,
and verification happen in the browser.

## What it does

- Open a PDF and click its text (or drag across part of a text run) to
  select an edit target. Selection is only offered when the rendered
  text maps **exactly and uniquely** to an engine text run — validated by
  full text equality plus position/contiguity geometry, never guessed.
- Replace a whole text run, or a fragment of one run, using the engine's
  two proven paths: same-font rewriting when the original font provably
  contains the replacement glyphs, or a fallback-font redraw with the
  original prefix/suffix preserved in place (fragment edits).
- Edit in place: in Edit Text mode (or with Enter/F2/double-click), an
  editor opens directly on the text, prefilled and styled like it, with a
  live width estimate from the engine's own measurements. Enter applies
  through the same validated path as the panel; Escape cancels without
  touching the document; a refusal keeps the editor open with the
  engine's reason shown.
- Toolbar with Select / Edit Text / Hand (drag to scroll) modes, zoom
  steps plus Fit Width / Fit Page, a page-number field with scroll-spy,
  Download, Reset — and Undo/Redo (up to 25 steps, additionally bounded
  by a 200 MB total history budget) recording only edits that were
  applied **and** successfully reloaded.
- See the edited PDF immediately, download it, reopen the exported copy,
  or reset to the original bytes (kept in memory, never overwritten).
- Every refusal is explicit: if an edit cannot be proven safe, the engine
  refuses with a reason and the document is left unchanged.

## Supported and refused

Supported: Latin-script text in native (non-scanned) PDFs, Tj/TJ text
operators, whole-run and single-run fragment replacement, rotated pages
and rotated text, multi-page documents.

Refused by design (with the reason shown): Arabic/Urdu/CJK replacement
text (script gate — correct RTL shaping is a separate future milestone),
`'`/`"` text operators, fonts that cannot be mapped to Unicode safely,
scanned/image-only pages, cross-run selections, and selections that
cannot be mapped unambiguously.

Known limitations: PDF has no reflow — a longer replacement can overlap
following text (the engine measures and reports the width change, and the
inline editor warns before you commit to a wider text); fallback-font
replacements are embedded whole in the browser build, so edited files are
larger than the Node engine's subset output; very large documents are
memory-bound (files over 50 MB are refused), and the undo history budget
means very large files keep fewer (but always at least one) undo steps.

## Develop

```sh
npm install
npm run dev        # Vite dev server
npm run build      # sync assets, typecheck, production build -> dist/
npm test           # engine-integration + selection-mapping tests (tsx)
npm run test:e2e   # Chromium end-to-end (needs a Chromium binary; see test/e2e.cjs)
```

`npm run build` copies the PDF.js worker, standard fonts, CMaps, and the
engine's fallback fonts into `public/assets/` first
(`scripts/sync-assets.mjs`); those directories are git-ignored and
regenerated from `node_modules` and `engine/assets`.

## Layout

- `src/` — the editor app (React + TypeScript + Vite): viewer
  (PDF.js), `engine-adapter.ts` (the only module that talks to the
  engine), `selection-map.ts` (validated viewer↔engine mapping).
- `engine/` — a vendored snapshot of the standalone engine; see
  `engine/ENGINE-NOTICE.md` for provenance. The standalone engine is the
  upstream — fix there first, then re-vendor.
- `test/` — fixtures (synthetic), `integration.mts`, `e2e.cjs`,
  `verify-export.mts`.
- `render.yaml` — Render static-site configuration for this app.

## Privacy

No document content, file names, or usage data are sent anywhere. The
production build is a static site; the only network requests the app
makes are for its own static assets (JS, the PDF.js worker, fonts) from
the same origin.

## Third-party components

pdf-lib (MIT), fontkit (MIT), PDF.js / pdfjs-dist (Apache-2.0), React
(MIT), Vite (MIT). Fallback fonts: Liberation family (SIL Open Font
License 1.1), DejaVu (permissive). This project's own licensing terms
are the project owner's to set; no license file is bundled yet by
design.
