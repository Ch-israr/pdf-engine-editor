# Vendored engine — provenance

The files under `engine/src/` and `engine/assets/` are a vendored snapshot
of the standalone TypeScript PDF text-editing engine developed in the
project owner's `engine-poc` workspace (SHA-256 manifest of the source
snapshot is preserved in that workspace at
`snapshots/phase10-inline/MANIFEST.json`). The standalone engine remains
the upstream: fixes should be made there first and re-vendored, so this
website never silently diverges from the validated engine.

Snapshot history: phase9-editor (2026-10-16, the original vendoring) →
phase10-inline (2026-10-16). The phase10 update changes exactly two
files, `src/replace.ts` and `src/fragment.ts`, and is purely additive:
it adds two read-only measurement functions used by the editor's inline
width warning — `measureReplacement` (replace.ts) and
`measureFragmentReplacement` (fragment.ts, which also extracts the
existing character→code boundary mapping into a shared internal helper
used by both the edit and the measure, with identical semantics). No
editing behaviour, glyph-coverage check, refusal rule, or safety gate
changed; the full upstream test battery (PoC, real-world, fragments,
audit probes, plus a new measure-parity suite) passes against the
updated sources.

The engine's public surface used by this app (via `src/engine-adapter.ts`
only):

- `loadAndExtract(pdfBytes)` — text-run extraction (src/extract.ts)
- `replaceRunText(pdfBytes, req)` — whole-run replacement (src/replace.ts)
- `replaceFragmentInRun(pdfBytes, req)` — fragment replacement (src/fragment.ts)
- `measureReplacement(pageData, run, replacement)` — read-only width/path estimate (src/replace.ts)
- `measureFragmentReplacement(pageData, run, start, end, replacement)` — read-only fragment estimate (src/fragment.ts)
- `configureEngine(cfg)` — host integration points (browser font loading)

All engine safety gates and refusals are preserved unchanged: the phase
script policy (Latin only — Arabic/Urdu/CJK replacements refuse), font
mappability proofs, operator restrictions (Tj/TJ only), width checks, and
text-state checks.

Third-party components the engine builds on: pdf-lib (MIT), fontkit
(MIT). Fallback fonts in `engine/assets/`: Liberation family (SIL Open
Font License 1.1) and DejaVu (permissive, see the fonts' own notices).
