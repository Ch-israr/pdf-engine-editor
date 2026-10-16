# Vendored engine — provenance

The files under `engine/src/` and `engine/assets/` are a vendored snapshot
of the standalone TypeScript PDF text-editing engine developed in the
project owner's `engine-poc` workspace (snapshot taken 2026-10-16;
SHA-256 manifest of the source snapshot is preserved in that workspace at
`snapshots/phase9-editor/MANIFEST.json`). The standalone engine remains
the upstream: fixes should be made there first and re-vendored, so this
website never silently diverges from the validated engine.

The engine's public surface used by this app (via `src/engine-adapter.ts`
only):

- `loadAndExtract(pdfBytes)` — text-run extraction (src/extract.ts)
- `replaceRunText(pdfBytes, req)` — whole-run replacement (src/replace.ts)
- `replaceFragmentInRun(pdfBytes, req)` — fragment replacement (src/fragment.ts)
- `configureEngine(cfg)` — host integration points (browser font loading)

All engine safety gates and refusals are preserved unchanged: the phase
script policy (Latin only — Arabic/Urdu/CJK replacements refuse), font
mappability proofs, operator restrictions (Tj/TJ only), width checks, and
text-state checks.

Third-party components the engine builds on: pdf-lib (MIT), fontkit
(MIT). Fallback fonts in `engine/assets/`: Liberation family (SIL Open
Font License 1.1) and DejaVu (permissive, see the fonts' own notices).
