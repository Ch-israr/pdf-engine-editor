// Validated mapping between the viewer's text items (PDF.js) and the
// engine's text runs. PDF.js splits a run's text into word/space items,
// so a run maps to a consecutive SEQUENCE of viewer items. A mapping is
// accepted only when it is exact and unique:
//   - the items' concatenated strings equal the run's text exactly;
//   - the first item's origin coincides with the run's recorded origin;
//   - consecutive items are geometrically contiguous along the run's
//     baseline direction (next origin = previous origin + width step);
//   - no other segmentation of the page's items satisfies the run.
// Anything else is reported unmapped with a reason — the editor never
// guesses a target from a substring alone.
import type { PageData } from '../engine/src/extract';

export interface ViewerItem {
  pageIndex: number;
  itemIndex: number;
  str: string;
  /** Origin (baseline start) in PDF page user space. */
  x: number;
  y: number;
  /** Advance width in unscaled text-space units (along the baseline). */
  width: number;
}

export interface MappedTarget {
  pageIndex: number;
  runOrdinal: number;
  runText: string;
  operator: string;
  /** Viewer item indices (on this page) whose concatenation is the run. */
  itemIndices: number[];
}

export interface UnmappedRun {
  pageIndex: number;
  runOrdinal: number;
  text: string;
  reason: string;
}

export interface MappingResult {
  targets: MappedTarget[];
  unmapped: UnmappedRun[];
}

const ORIGIN_TOLERANCE_PT = 2.5;
const JOINT_TOLERANCE_PT = 1.5;

interface RunLike {
  ordinal: number; text: string; x: number; y: number; angleDeg: number; mappable: boolean; operator: string;
}

/** Find every segmentation of `items` (same page order) that exactly
 *  reproduces the run, honouring origin + baseline contiguity. */
function segmentations(run: RunLike, items: ViewerItem[]): number[][] {
  const results: number[][] = [];
  const rad = (run.angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const usable = items.filter((it) => it.str.length > 0);
  for (let s = 0; s < usable.length; s++) {
    const first = usable[s];
    if (Math.hypot(first.x - run.x, first.y - run.y) > ORIGIN_TOLERANCE_PT) continue;
    let acc = '';
    let px = first.x, py = first.y;
    const seq: number[] = [];
    for (let j = s; j < usable.length; j++) {
      const it = usable[j];
      if (j > s) {
        const prev = usable[j - 1];
        const ex = px + dx * prev.width, ey = py + dy * prev.width;
        if (Math.hypot(it.x - ex, it.y - ey) > JOINT_TOLERANCE_PT) break;
        px = it.x; py = it.y;
      }
      acc += it.str;
      seq.push(it.itemIndex);
      if (acc === run.text) { results.push([...seq]); break; }
      if (acc.length > run.text.length || !run.text.startsWith(acc)) break;
    }
    if (results.length > 1) break; // ambiguity already proven
  }
  return results;
}

export function mapRunsToItems(pages: PageData[], itemsByPage: ViewerItem[][]): MappingResult {
  const targets: MappedTarget[] = [];
  const unmapped: UnmappedRun[] = [];
  const claimed = new Set<string>();

  for (const page of pages) {
    const items = itemsByPage[page.pageIndex] ?? [];
    for (const run of page.runs) {
      const found = segmentations(run, items);
      if (found.length === 0) {
        unmapped.push({
          pageIndex: page.pageIndex, runOrdinal: run.ordinal, text: run.text,
          reason: 'no sequence of viewer items reproduces this run\u2019s text at its recorded position',
        });
        continue;
      }
      if (found.length > 1) {
        unmapped.push({
          pageIndex: page.pageIndex, runOrdinal: run.ordinal, text: run.text,
          reason: 'ambiguous: more than one viewer-item sequence reproduces this run',
        });
        continue;
      }
      const seq = found[0];
      const clash = seq.find((idx) => claimed.has(`${page.pageIndex}:${idx}`));
      if (clash !== undefined) {
        unmapped.push({
          pageIndex: page.pageIndex, runOrdinal: run.ordinal, text: run.text,
          reason: 'ambiguous: a viewer item in this run\u2019s sequence is claimed by another run',
        });
        continue;
      }
      if (!run.mappable) {
        unmapped.push({
          pageIndex: page.pageIndex, runOrdinal: run.ordinal, text: run.text,
          reason: 'the run\u2019s font cannot be mapped to Unicode safely (engine would refuse)',
        });
        continue;
      }
      seq.forEach((idx) => claimed.add(`${page.pageIndex}:${idx}`));
      targets.push({
        pageIndex: page.pageIndex, runOrdinal: run.ordinal, runText: run.text,
        operator: run.operator, itemIndices: seq,
      });
    }
  }
  return { targets, unmapped };
}

export interface FragmentRange { start: number; end: number }

/** Validate a character range chosen inside one mapped run (possibly
 *  spanning several of the run's viewer items). The selected text must
 *  equal the run's slice exactly. */
export function validateFragment(
  target: MappedTarget, rangeStart: number, rangeEnd: number, selText: string,
): { ok: true; range: FragmentRange } | { ok: false; reason: string } {
  if (rangeStart < 0 || rangeEnd > target.runText.length || rangeStart >= rangeEnd) {
    return { ok: false, reason: 'the selection is empty or outside the run' };
  }
  if (target.runText.slice(rangeStart, rangeEnd) !== selText) {
    return { ok: false, reason: 'the selected characters do not match the engine run text at those offsets (stale or altered mapping)' };
  }
  return { ok: true, range: { start: rangeStart, end: rangeEnd } };
}

/** Convert (itemIndex, offsetInItem) endpoints within one target into a
 *  run-level character range, using the items' string lengths in order. */
export function rangeInRun(
  target: MappedTarget,
  items: ViewerItem[],
  aItem: number, aOffset: number,
  bItem: number, bOffset: number,
): FragmentRange {
  const byIndex = new Map(items.map((it) => [it.itemIndex, it]));
  const pos = (itemIdx: number, off: number) => {
    let acc = 0;
    for (const idx of target.itemIndices) {
      if (idx === itemIdx) return acc + off;
      acc += byIndex.get(idx)?.str.length ?? 0;
    }
    return acc;
  };
  const pa = pos(aItem, aOffset), pb = pos(bItem, bOffset);
  return { start: Math.min(pa, pb), end: Math.max(pa, pb) };
}
