import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  applyFragment, applyWholeRun, extractDocument, measureFragment, measureWholeRun,
  type EditOutcome, type PageData,
} from './engine-adapter';
import {
  mapRunsToItems, rangeInRun, validateFragment, type MappedTarget, type MappingResult, type ViewerItem,
} from './selection-map';
import { openInlineEditor, type InlineEditorHandle } from './inline-editor';

GlobalWorkerOptions.workerSrc = 'assets/pdfjs/pdf.worker.min.mjs';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Undo/redo history: at most 25 states AND at most ~200 MB of retained
// document bytes across the undo stack, the redo stack, and the current
// document. States are stored by reference (document byte arrays are
// never mutated in place), so the accounting below is the real memory
// cost. The most recent undo state is always kept, so at least one undo
// step survives even for very large files.
const HISTORY_MAX = 25;
const HISTORY_BUDGET_BYTES = 200 * 1024 * 1024;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

type Mode = 'select' | 'edit' | 'hand';

interface Session {
  name: string;
  // The file the user opened first in this session. These two fields are
  // pinned at open time and NEVER reassigned afterwards — in particular,
  // opening the exported copy must not replace them, so "Reset to original"
  // always returns to the file the user actually opened.
  originalName: string;
  originalBytes: Uint8Array;
  currentBytes: Uint8Array;
  edits: string[];
}

interface DocState { bytes: Uint8Array; edits: string[] }

interface SelectionState {
  target: MappedTarget;
  mode: 'whole-run' | 'fragment';
  fragment?: { start: number; end: number; text: string };
}

interface StatusEntry { kind: 'ok' | 'error' | 'info'; text: string }

const selectionKey = (s: SelectionState) =>
  s.mode === 'whole-run'
    ? `${s.target.pageIndex}:${s.target.runOrdinal}:whole`
    : `${s.target.pageIndex}:${s.target.runOrdinal}:frag:${s.fragment!.start}-${s.fragment!.end}`;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [enginePages, setEnginePages] = useState<PageData[]>([]);
  const [mapping, setMapping] = useState<MappingResult>({ targets: [], unmapped: [] });
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [replacement, setReplacement] = useState('');
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [scale, setScale] = useState(1.25);
  const [pageNow, setPageNow] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('select');
  const [fitMode, setFitMode] = useState<'width' | 'page' | null>(null);
  const [, setHistVersion] = useState(0);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const viewerBusyRef = useRef(false);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const renderGenRef = useRef(0);
  const itemsRef = useRef<ViewerItem[][]>([]);
  const pageSizesRef = useRef<{ w: number; h: number }[]>([]);
  const pageRotationsRef = useRef<number[]>([]);
  const pageNowRef = useRef(1);
  const sessionRef = useRef<Session | null>(null);
  const selectionRef = useRef<SelectionState | null>(null);
  const modeRef = useRef<Mode>('select');
  const fitModeRef = useRef<'width' | 'page' | null>(null);
  const scaleRef = useRef(1.25);
  const busyRef = useRef(false);
  const pastRef = useRef<DocState[]>([]);
  const futureRef = useRef<DocState[]>([]);
  const inlineRef = useRef<InlineEditorHandle | null>(null);
  const openInlineRef = useRef<((s: SelectionState) => void) | null>(null);
  const handDragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  // Key of the selection the panel currently reflects. Browsers deliver
  // selectionchange asynchronously (and sometimes repeatedly); a repeat
  // delivery for the SAME selection must not clobber text the user has
  // already typed into the replacement box.
  const selKeyRef = useRef('');

  sessionRef.current = session;
  selectionRef.current = selection;
  modeRef.current = mode;
  fitModeRef.current = fitMode;
  scaleRef.current = scale;

  const say = useCallback((kind: StatusEntry['kind'], text: string) => {
    setStatus((s) => [{ kind, text }, ...s].slice(0, 30));
  }, []);

  const bumpHist = useCallback(() => setHistVersion((v) => v + 1), []);

  const closeInline = useCallback(() => {
    if (inlineRef.current && !inlineRef.current.isClosed()) inlineRef.current.close();
    inlineRef.current = null;
  }, []);

  // --- History accounting -------------------------------------------------
  const retainedBytes = useCallback((currentBytes: Uint8Array) => {
    const seen = new Set<Uint8Array>([currentBytes]);
    let total = currentBytes.byteLength;
    for (const s of [...pastRef.current, ...futureRef.current]) {
      if (!seen.has(s.bytes)) { seen.add(s.bytes); total += s.bytes.byteLength; }
    }
    return total;
  }, []);

  const trimHistory = useCallback((currentBytes: Uint8Array) => {
    // Oldest undo states go first; the newest one always survives so at
    // least one undo step exists. Redo states drop from the far end.
    while ((pastRef.current.length > HISTORY_MAX || retainedBytes(currentBytes) > HISTORY_BUDGET_BYTES) && pastRef.current.length > 1) {
      pastRef.current.shift();
    }
    while ((futureRef.current.length > HISTORY_MAX || retainedBytes(currentBytes) > HISTORY_BUDGET_BYTES) && futureRef.current.length > 1) {
      futureRef.current.pop();
    }
  }, [retainedBytes]);

  const clearHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    bumpHist();
  }, [bumpHist]);

  const destroyPdf = useCallback(async () => {
    if (pdfDocRef.current) {
      const doc = pdfDocRef.current;
      pdfDocRef.current = null;
      // Never let a stuck destroy stall the next document: race it and
      // abandon the old document if the worker does not answer promptly
      // (the generation counter already keeps stale renders out).
      try {
        await Promise.race([
          doc.destroy(),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch { /* already gone */ }
    }
  }, []);

  /** (Re)build the viewer + engine extraction + mapping for a byte state. */
  const loadIntoViewerImpl = useCallback(async (bytes: Uint8Array, keepPage = false) => {
    const gen = ++renderGenRef.current;
    viewerBusyRef.current = true;
    await destroyPdf();
    const host = pagesHostRef.current;
    if (host) host.innerHTML = '';
    setSelection(null);
    selKeyRef.current = '';
    const keepPageNum = keepPage ? pageNowRef.current : 1;

    const extracted = await extractDocument(bytes.slice());
    if (gen !== renderGenRef.current) return;
    setEnginePages(extracted.pages);

    const doc = await getDocument({
      data: bytes.slice(),
      standardFontDataUrl: 'assets/standard_fonts/',
      cMapUrl: 'assets/cmaps/',
      cMapPacked: true,
    }).promise;
    if (gen !== renderGenRef.current) { await doc.destroy(); return; }
    pdfDocRef.current = doc;
    setPageCount(doc.numPages);
    if (!host) return;

    const itemsByPage: ViewerItem[][] = [];
    const sizes: { w: number; h: number }[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page: PDFPageProxy = await doc.getPage(p);
      const unit = page.getViewport({ scale: 1 });
      sizes[p - 1] = { w: unit.width, h: unit.height };
      const viewport = page.getViewport({ scale });
      pageRotationsRef.current[p - 1] = viewport.rotation;
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = String(p);
      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * devicePixelRatio);
      canvas.height = Math.floor(viewport.height * devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      wrap.appendChild(canvas);
      const ctx = canvas.getContext('2d')!;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      // A page's canvas render must never block the text layer/mapping:
      // some environments leave the render promise unsettled even while
      // painting completes. Race it and continue honestly on timeout.
      const renderTask = page.render({ canvasContext: ctx, viewport });
      const settled = await Promise.race([
        renderTask.promise.then(() => 'done').catch(() => 'error'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 6000)),
      ]);
      if (settled === 'timeout') {
        renderTask.cancel();
        say('info', `Page ${p}: the canvas render did not settle within 6s in this browser — the page image may still appear, and text selection/editing is unaffected.`);
      }
      if (gen !== renderGenRef.current) return;

      // Same resilience for the text layer: a page whose text layer cannot
      // be built in time is shown but its runs stay unselectable, with the
      // reason reported — the document as a whole never stalls.
      const textContent = await Promise.race([
        page.getTextContent().catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 15000)),
      ]);
      if (!textContent) {
        say('error', `Page ${p}: the text layer did not build in this browser, so this page's text cannot be selected safely. Other pages are unaffected.`);
        itemsByPage[p - 1] = [];
        host.appendChild(wrap);
        continue;
      }
      const layerDiv = document.createElement('div');
      layerDiv.className = 'textLayer';
      layerDiv.style.setProperty('--scale-factor', String(scale));
      // pdf.js builds the text layer in the page's UNROTATED frame (its
      // own transform is a plain y-flip over the raw page dims) and stamps
      // data-main-rotation on the layer; rotating the layer box into the
      // displayed (rotated) page box is the host's job — pdf.js's viewer
      // does it, and so must we, or the spans sit in unrotated positions
      // while the canvas shows the rotated page (found by the Phase C
      // rotate90 browser test: selection highlights and click targets
      // were displaced from the visible text on /Rotate pages).
      const rot = viewport.rotation;
      if (rot === 90 || rot === 270) {
        // Layer box is rawW x rawH; the wrap is rawH x rawW. In viewport
        // terms at this scale: layer height = viewport.width, layer
        // width = viewport.height.
        layerDiv.style.transformOrigin = '0 0';
        layerDiv.style.transform = rot === 90
          ? `translate(${viewport.width}px, 0px) rotate(90deg)`
          : `translate(0px, ${viewport.height}px) rotate(-90deg)`;
      } else if (rot === 180) {
        layerDiv.style.transformOrigin = 'center';
        layerDiv.style.transform = 'rotate(180deg)';
      }
      wrap.appendChild(layerDiv);
      const layer = new TextLayer({ textContentSource: textContent, container: layerDiv, viewport });
      await Promise.race([
        layer.render().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 15000)),
      ]);
      layer.textDivs.forEach((div, i) => {
        div.dataset.page = String(p - 1);
        div.dataset.item = String(i);
      });
      itemsByPage[p - 1] = textContent.items
        .filter((it): it is Extract<typeof it, { str: string }> => 'str' in it)
        .map((it, i) => ({
          pageIndex: p - 1, itemIndex: i, str: it.str, x: it.transform[4], y: it.transform[5], width: it.width,
        }));
      host.appendChild(wrap);
    }
    if (gen !== renderGenRef.current) return;
    itemsRef.current = itemsByPage;
    pageSizesRef.current = sizes;
    const target = Math.min(Math.max(keepPageNum, 1), doc.numPages);
    pageNowRef.current = target;
    setPageNow(target);
    if (keepPage && target > 1) {
      host.querySelector(`.page-wrap[data-page="${target}"]`)?.scrollIntoView({ block: 'start' });
    } else if (!keepPage) {
      viewerRef.current?.scrollTo({ top: 0 });
    }
    const result = mapRunsToItems(extracted.pages, itemsByPage);
    setMapping(result);
    // Any selection resolved DURING this load was resolved against the
    // previous document's mapping; leave a clean slate so the next user
    // selection always refills the panel from the current mapping.
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    selKeyRef.current = '';
    if (gen === renderGenRef.current) viewerBusyRef.current = false;
    say('info', `Mapped ${result.targets.length} editable run(s); ${result.unmapped.length} run(s) cannot be mapped safely and are not selectable.`);
  }, [destroyPdf, scale, say]);

  const loadSeqRef = useRef(0);
  const loadIntoViewer = useCallback(async (bytes: Uint8Array, keepPage = false) => {
    const seq = ++loadSeqRef.current;
    try {
      await loadIntoViewerImpl(bytes, keepPage);
    } catch (e) {
      // A failed load must not leave selection locked off — unless a
      // newer load has already taken over the viewer.
      if (loadSeqRef.current === seq) viewerBusyRef.current = false;
      throw e;
    }
  }, [loadIntoViewerImpl]);

  // Re-render at a new zoom (keeps the same bytes and edit history).
  // Zooming cancels any open inline edit (its anchors are invalidated).
  useEffect(() => {
    if (sessionRef.current) {
      if (inlineRef.current && !inlineRef.current.isClosed()) {
        closeInline();
        say('info', 'Zoom changed — the inline edit was cancelled and its draft discarded.');
      }
      void loadIntoViewer(sessionRef.current.currentBytes, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const openFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      say('error', `File is ${(file.size / 1048576).toFixed(1)} MB — the in-browser limit for this editor is 50 MB.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    closeInline();
    clearHistory();
    setSession({ name: file.name, originalName: file.name, originalBytes: bytes, currentBytes: bytes, edits: [] });
    setReplacement('');
    say('info', `Opened ${file.name} (${(file.size / 1024).toFixed(0)} KB). Processing is entirely local — nothing is uploaded.`);
    await loadIntoViewer(bytes);
    if (fitModeRef.current) applyFitRef.current?.(fitModeRef.current);
  }, [clearHistory, closeInline, loadIntoViewer, say]);

  // Selection → validated target. Runs on every selection change.
  useEffect(() => {
    const onSel = () => {
      if (modeRef.current === 'hand') return;
      // While a (re)load is in flight, the on-screen spans and the
      // mapping state belong to different document states; resolving a
      // selection now could target the wrong run or produce a bogus
      // "not mappable" error. Ignore it — the user can click again once
      // the load lands (loads also clear the selection at their end).
      if (viewerBusyRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const anchorDiv = (sel.anchorNode?.parentElement?.closest?.('[data-item]') ?? null) as HTMLElement | null;
      const focusDiv = (sel.focusNode?.parentElement?.closest?.('[data-item]') ?? null) as HTMLElement | null;
      // A selectionchange can also fire for spans a reload just removed;
      // those events carry a stale mapping context and must be ignored.
      if (anchorDiv && !anchorDiv.isConnected) return;
      if (focusDiv && !focusDiv.isConnected) return;
      document.querySelectorAll('.textLayer .run-selected').forEach((el) => el.classList.remove('run-selected'));
      if (!anchorDiv || !focusDiv) return;
      if (anchorDiv.dataset.page !== focusDiv.dataset.page) {
        say('error', 'That selection spans more than one page. Select text inside a single run — cross-run editing is not supported.');
        return;
      }
      const pageIndex = Number(anchorDiv.dataset.page);
      const aItem = Number(anchorDiv.dataset.item);
      const fItem = Number(focusDiv.dataset.item);
      const target = mapping.targets.find((t) => t.pageIndex === pageIndex && t.itemIndices.includes(aItem));
      if (!target) {
        say('error', 'That text is not safely mappable to an engine text run, so it cannot be edited.');
        return;
      }
      if (!target.itemIndices.includes(fItem)) {
        say('error', 'That selection spans more than one text run. Select text inside a single run — cross-run editing is not supported.');
        return;
      }
      document.querySelectorAll(`.textLayer [data-page="${pageIndex}"]`).forEach((el) => {
        if (target.itemIndices.includes(Number((el as HTMLElement).dataset.item))) el.classList.add('run-selected');
      });
      let selState: SelectionState;
      if (sel.isCollapsed) {
        const key = `${target.pageIndex}:${target.runOrdinal}:whole`;
        selState = { target, mode: 'whole-run' };
        setSelection(selState);
        if (selKeyRef.current !== key) { selKeyRef.current = key; setReplacement(target.runText); }
      } else {
        const selText = sel.toString();
        const range = rangeInRun(target, itemsRef.current[pageIndex] ?? [], aItem, sel.anchorOffset, fItem, sel.focusOffset);
        const v = validateFragment(target, range.start, range.end, selText);
        if (!v.ok) {
          say('error', `Fragment selection refused: ${v.reason}.`);
          setSelection({ target, mode: 'whole-run' });
          return;
        }
        const key = `${target.pageIndex}:${target.runOrdinal}:frag:${v.range.start}-${v.range.end}`;
        selState = { target, mode: 'fragment', fragment: { start: v.range.start, end: v.range.end, text: selText } };
        setSelection(selState);
        if (selKeyRef.current !== key) { selKeyRef.current = key; setReplacement(selText); }
      }
      // In Edit Text mode, resolving a selection opens the inline editor
      // for it directly (click = whole run, drag = fragment).
      if (modeRef.current === 'edit') openInlineRef.current?.(selState);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [mapping, say]);

  /** Validate + reload a candidate byte state; the viewer keeps showing
   *  the committed state if anything fails. Returns success. */
  const reloadViewer = useCallback(async (bytes: Uint8Array): Promise<boolean> => {
    try { await extractDocument(bytes.slice()); } catch { return false; }
    try { await loadIntoViewer(bytes, true); return true; } catch { return false; }
  }, [loadIntoViewer]);

  /** The one edit path, shared by the panel and the inline editor. The
   *  session and the undo history advance ONLY after the engine accepted
   *  the edit AND the result reloaded successfully in the viewer — a
   *  refusal, a failed validation, or a failed reload records nothing. */
  const performEdit = useCallback(async (text: string): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> => {
    const sess = sessionRef.current;
    const selState = selectionRef.current;
    if (!sess || !selState) return { ok: false, reason: 'no-selection', detail: 'Select text in the document first.' };
    const { target, mode: editMode, fragment } = selState;
    let out: EditOutcome;
    try {
      out = editMode === 'whole-run'
        ? await applyWholeRun(sess.currentBytes, target.pageIndex, target.runOrdinal, target.runText, text)
        : await applyFragment(sess.currentBytes, {
          pageIndex: target.pageIndex, runOrdinal: target.runOrdinal, matchText: target.runText,
          start: fragment!.start, end: fragment!.end, replacement: text,
        });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      say('error', `Edit failed unexpectedly: ${detail}`);
      return { ok: false, reason: 'unexpected-error', detail };
    }
    if (!out.ok) {
      say('error', `Edit refused (${out.reason}): ${out.detail} — the document was not changed.`);
      return { ok: false, reason: out.reason, detail: out.detail };
    }
    const label = `${editMode === 'whole-run' ? 'Run' : 'Fragment'} p${target.pageIndex + 1}#${target.runOrdinal}: ${JSON.stringify(editMode === 'whole-run' ? target.runText : fragment!.text)} → ${JSON.stringify(text)} (${out.path})`;
    const reloaded = await reloadViewer(out.bytes!);
    if (!reloaded) {
      // Best effort: put the committed state back on screen.
      try { await loadIntoViewer(sess.currentBytes, true); } catch { /* viewer already reports its own errors */ }
      say('error', 'The engine produced the edit, but the result could not be reloaded and verified in the viewer, so it was discarded — the document is unchanged and nothing was recorded in the history.');
      return { ok: false, reason: 'reload-failed', detail: 'The edited document could not be reloaded for verification; the edit was discarded.' };
    }
    pastRef.current = [...pastRef.current, { bytes: sess.currentBytes, edits: sess.edits }];
    futureRef.current = [];
    trimHistory(out.bytes!);
    setSession({ ...sess, currentBytes: out.bytes!, edits: [...sess.edits, label] });
    say('ok', `Edited via ${out.path}. ${out.detail}`);
    bumpHist();
    return { ok: true };
  }, [bumpHist, loadIntoViewer, reloadViewer, say, trimHistory]);

  const applyEdit = useCallback(async () => {
    if (!sessionRef.current || !selectionRef.current || busyRef.current) return;
    setBusy(true); busyRef.current = true;
    await performEdit(replacement);
    setBusy(false); busyRef.current = false;
  }, [performEdit, replacement]);

  const undo = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess || busyRef.current || pastRef.current.length === 0) return;
    setBusy(true); busyRef.current = true;
    closeInline();
    const targetState = pastRef.current[pastRef.current.length - 1];
    const ok = await reloadViewer(targetState.bytes);
    if (ok) {
      futureRef.current = [{ bytes: sess.currentBytes, edits: sess.edits }, ...futureRef.current];
      pastRef.current = pastRef.current.slice(0, -1);
      trimHistory(targetState.bytes);
      setSession({ ...sess, currentBytes: targetState.bytes, edits: targetState.edits });
      say('info', `Undo — the document is back to ${targetState.edits.length} applied edit(s).`);
      bumpHist();
    } else {
      try { await loadIntoViewer(sess.currentBytes, true); } catch { /* best effort */ }
      say('error', 'Undo failed: the earlier state could not be reloaded, so nothing was changed.');
    }
    setBusy(false); busyRef.current = false;
  }, [bumpHist, closeInline, loadIntoViewer, reloadViewer, say, trimHistory]);

  const redo = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess || busyRef.current || futureRef.current.length === 0) return;
    setBusy(true); busyRef.current = true;
    closeInline();
    const targetState = futureRef.current[0];
    const ok = await reloadViewer(targetState.bytes);
    if (ok) {
      pastRef.current = [...pastRef.current, { bytes: sess.currentBytes, edits: sess.edits }];
      futureRef.current = futureRef.current.slice(1);
      trimHistory(targetState.bytes);
      setSession({ ...sess, currentBytes: targetState.bytes, edits: targetState.edits });
      say('info', `Redo — the document is back to ${targetState.edits.length} applied edit(s).`);
      bumpHist();
    } else {
      try { await loadIntoViewer(sess.currentBytes, true); } catch { /* best effort */ }
      say('error', 'Redo failed: the later state could not be reloaded, so nothing was changed.');
    }
    setBusy(false); busyRef.current = false;
  }, [bumpHist, closeInline, loadIntoViewer, reloadViewer, say, trimHistory]);

  const download = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) return;
    const blob = new Blob([sess.currentBytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sess.name.replace(/\.pdf$/i, '') + '-edited.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    say('ok', 'Downloaded the edited PDF. You can reopen it here with “Open exported copy”.');
  }, [say]);

  const reset = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    closeInline();
    clearHistory();
    setSession({ ...sess, name: sess.originalName, currentBytes: sess.originalBytes, edits: [] });
    say('info', `Reset to ${sess.originalName} — the file you opened first. All edits were discarded.`);
    await loadIntoViewer(sess.originalBytes);
  }, [clearHistory, closeInline, loadIntoViewer, say]);

  const reopenExported = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    closeInline();
    clearHistory();
    const bytes = sess.currentBytes;
    // The exported copy becomes the open document, but the session's pinned
    // original (originalName/originalBytes) is deliberately left untouched:
    // Reset must always be able to return to the file the user opened first.
    setSession({ ...sess, name: sess.name.replace(/\.pdf$/i, '') + '-edited.pdf', currentBytes: bytes, edits: [] });
    say('info', `The exported copy is now the open document. “Reset to original” still returns to ${sess.originalName}, the file you opened first.`);
    await loadIntoViewer(bytes);
  }, [clearHistory, closeInline, loadIntoViewer, say]);

  const gotoPage = useCallback((p: number) => {
    const host = pagesHostRef.current;
    const el = host?.querySelector(`.page-wrap[data-page="${p}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pageNowRef.current = p;
    setPageNow(p);
  }, []);

  // --- Zoom / fit -----------------------------------------------------------
  const computeFitScale = useCallback((kind: 'width' | 'page'): number | null => {
    const viewer = viewerRef.current;
    const size = pageSizesRef.current[pageNowRef.current - 1];
    if (!viewer || !size || size.w === 0) return null;
    const availW = Math.max(50, viewer.clientWidth - 48);
    const fitW = availW / size.w;
    const s = kind === 'width' ? fitW : Math.min(fitW, Math.max(50, viewer.clientHeight - 48) / size.h);
    return Math.min(4, Math.max(0.25, s));
  }, []);

  const applyFit = useCallback((kind: 'width' | 'page') => {
    const s = computeFitScale(kind);
    if (s === null) return;
    setFitMode(kind);
    if (Math.abs(s - scaleRef.current) > 0.005) setScale(s);
  }, [computeFitScale]);
  const applyFitRef = useRef(applyFit);
  applyFitRef.current = applyFit;

  const manualZoom = useCallback((next: number) => {
    setFitMode(null);
    setScale(Math.min(4, Math.max(0.25, next)));
  }, []);

  const zoomStep = useCallback((dir: 1 | -1) => {
    const cur = scaleRef.current;
    const steps = ZOOM_STEPS;
    const next = dir === 1
      ? steps.find((s) => s > cur + 0.005) ?? steps[steps.length - 1]
      : [...steps].reverse().find((s) => s < cur - 0.005) ?? steps[0];
    manualZoom(next);
  }, [manualZoom]);

  // Keep an active fit mode fitted when the window/viewer resizes.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const kind = fitModeRef.current;
        if (!kind || !sessionRef.current) return;
        // Never recompute mid-reload: emptying the pages host makes the
        // scrollbars vanish, which transiently widens the viewer, which
        // would corrupt the fit scale and retrigger itself in a loop.
        // When the load lands, the layout settles and any genuine size
        // change produces a fresh resize event to recompute from.
        if (viewerBusyRef.current) return;
        const s = computeFitScale(kind);
        if (s !== null && Math.abs(s - scaleRef.current) > 0.005) setScale(s);
      });
    });
    ro.observe(viewer);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [computeFitScale]);

  // Scroll-spy: the pager follows the page actually on screen. The
  // scroller differs by layout: on wide screens the viewer pane scrolls
  // internally; in the narrow (<=900px) layout the viewer grows to full
  // height and the window scrolls instead — listen to both and measure
  // against whichever top edge is actually visible.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const host = pagesHostRef.current;
        if (!host) return;
        const refLine = Math.max(viewer.getBoundingClientRect().top, 0) + 40;
        let current = 0;
        for (const wrap of Array.from(host.querySelectorAll<HTMLElement>('.page-wrap'))) {
          const r = wrap.getBoundingClientRect();
          if (r.bottom > refLine) { current = Number(wrap.dataset.page); break; }
          current = Number(wrap.dataset.page);
        }
        if (current > 0 && current !== pageNowRef.current) {
          pageNowRef.current = current;
          setPageNow(current);
        }
      });
    };
    viewer.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      viewer.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  // --- Inline editing -------------------------------------------------------
  const requestInlineEdit = useCallback((selState: SelectionState) => {
    if (busyRef.current || !sessionRef.current) return;
    const host = pagesHostRef.current;
    const wrap = host?.querySelector<HTMLElement>(`.page-wrap[data-page="${selState.target.pageIndex + 1}"]`);
    if (!wrap) return;
    const spans = selState.target.itemIndices
      .map((i) => wrap.querySelector<HTMLElement>(`.textLayer [data-item="${i}"]`))
      .filter((el): el is HTMLElement => !!el);
    if (spans.length === 0) {
      say('error', 'The inline editor could not be anchored to that text in this browser. The panel editor remains available.');
      return;
    }
    closeInline();
    const wRect = wrap.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      left = Math.min(left, r.left - wRect.left);
      top = Math.min(top, r.top - wRect.top);
      right = Math.max(right, r.right - wRect.left);
      bottom = Math.max(bottom, r.bottom - wRect.top);
    }
    let width = right - left;
    let height = bottom - top;
    // A fragment occupies a proportional slice of the run's rendered box
    // along its long axis (runs are single-line; TJ kerning makes this an
    // approximation of position only — the edit itself is validated
    // exactly as always).
    if (selState.mode === 'fragment' && selState.fragment) {
      const total = Math.max(1, selState.target.runText.length);
      const f0 = selState.fragment.start / total;
      const f1 = (selState.fragment.end - selState.fragment.start) / total;
      if (height > width) {
        const t = top + height * f0;
        height = height * f1;
        top = t;
      } else {
        const l = left + width * f0;
        width = width * f1;
        left = l;
      }
    }
    const cs = getComputedStyle(spans[0]);
    const fontSizePx = parseFloat(cs.fontSize) || 14;
    let angleDeg = 0;
    const m = /matrix\(([^)]+)\)/.exec(cs.transform);
    if (m) {
      const [a, b] = m[1].split(',').map((v) => parseFloat(v));
      if (Number.isFinite(a) && Number.isFinite(b)) angleDeg = (Math.atan2(b, a) * 180) / Math.PI;
    }
    // The display angle of the text is the page's own rotation (applied to
    // the text layer as a whole) plus the span's own baseline angle.
    const pageRot = pageRotationsRef.current[selState.target.pageIndex] ?? 0;
    const cssRot = pageRot === 270 ? -90 : pageRot;
    let displayAngle = cssRot + angleDeg;
    if (displayAngle > 180) displayAngle -= 360;
    if (displayAngle < -180) displayAngle += 360;
    const rotated = Math.abs(displayAngle) >= 45;
    const anchor = rotated
      ? {
        left: left + width / 2, top: top + height / 2, center: true,
        width: Math.max(width, height), height: Math.min(width, height),
        angleDeg: displayAngle, fontSizePx, fontFamily: cs.fontFamily,
      }
      : {
        left, top, width, height, angleDeg: displayAngle, fontSizePx, fontFamily: cs.fontFamily,
      };
    const capturedKey = selectionKey(selState);
    const pageData = enginePages[selState.target.pageIndex];
    const run = pageData?.runs[selState.target.runOrdinal];
    let measureToken = 0;
    const handle = openInlineEditor(wrap, {
      initialText: selState.mode === 'whole-run' ? selState.target.runText : selState.fragment!.text,
      anchor,
      onCommit: (text) => {
        if (busyRef.current) return;
        if (!selectionRef.current || selectionKey(selectionRef.current) !== capturedKey) {
          handle.showError('The selection changed since this editor opened, so the edit was not applied. Select the text again to edit it.');
          return;
        }
        setBusy(true); busyRef.current = true;
        void performEdit(text).then((r) => {
          setBusy(false); busyRef.current = false;
          if (r.ok) handle.close();
          else if (r.reason !== 'reload-failed') handle.showError(`Edit refused (${r.reason}): ${r.detail}`);
          else handle.close();
        });
      },
      onCancel: () => { /* draft discarded by the overlay itself; the selection is retained */ },
      onMeasure: (text) => {
        if (!pageData || !run) return;
        const token = ++measureToken;
        void (async () => {
          try {
            if (selState.mode === 'whole-run') {
              const mm = await measureWholeRun(pageData, run, text);
              if (token !== measureToken || handle.isClosed()) return;
              if (mm.path === 'refused') {
                handle.setMeasure(`The engine will refuse this edit (${mm.reason}).`, true);
              } else if (mm.widthBeforePt !== null && mm.widthAfterPt !== null) {
                const d = mm.widthAfterPt - mm.widthBeforePt;
                handle.setMeasure(
                  `Width ≈ ${mm.widthBeforePt.toFixed(1)} pt → ${mm.widthAfterPt.toFixed(1)} pt (${mm.path === 'same-font' ? 'original font' : 'fallback font'})` +
                  (d > 0.5 ? ' — text does not reflow; a wider replacement may overlap what follows.' : d < -0.5 ? ' — narrower than the original.' : ''),
                  d > 0.5,
                );
              } else {
                handle.setMeasure('The width change cannot be measured in advance for this font.', false);
              }
            } else {
              const mm = await measureFragment(pageData, run, selState.fragment!.start, selState.fragment!.end, text);
              if (token !== measureToken || handle.isClosed()) return;
              if (mm.path === 'refused') {
                handle.setMeasure(`The engine will refuse this edit (${mm.reason}).`, true);
              } else if (mm.fragAdvancePt !== null && mm.replacementAdvancePt !== null) {
                const d = mm.replacementAdvancePt - mm.fragAdvancePt;
                handle.setMeasure(
                  `Fragment width ≈ ${mm.fragAdvancePt.toFixed(1)} pt → ${mm.replacementAdvancePt.toFixed(1)} pt (${mm.path === 'same-font' ? 'original font' : 'fallback font'})` +
                  (d > 0.5 ? ' — the rest of the run shifts by the difference.' : ''),
                  d > 0.5,
                );
              } else {
                handle.setMeasure('The width change cannot be measured in advance for this font.', false);
              }
            }
          } catch { /* measuring is advisory only; never block the edit */ }
        })();
      },
    });
    inlineRef.current = handle;
  }, [closeInline, enginePages, performEdit, say]);
  openInlineRef.current = requestInlineEdit;

  const switchMode = useCallback((next: Mode) => {
    closeInline();
    setMode(next);
  }, [closeInline]);

  // Keyboard: undo/redo, inline-edit openers, mode shortcuts. Plain
  // typing contexts (inputs, selects) keep their native behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      if (mod && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); void redo(); return; }
      if (typing) return;
      if ((e.key === 'Enter' || e.key === 'F2') && selectionRef.current && (!inlineRef.current || inlineRef.current.isClosed())) {
        e.preventDefault();
        requestInlineEdit(selectionRef.current);
        return;
      }
      if (!mod && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') switchMode('select');
        else if (e.key === 't' || e.key === 'T') switchMode('edit');
        else if (e.key === 'h' || e.key === 'H') switchMode('hand');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [redo, requestInlineEdit, switchMode, undo]);

  // Hand mode: drag the viewer to scroll; the text layer ignores the
  // pointer (see styles) so drags never start a selection.
  const onViewerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (modeRef.current !== 'hand') return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    e.preventDefault();
    handDragRef.current = { x: e.clientX, y: e.clientY, sl: viewer.scrollLeft, st: viewer.scrollTop };
    viewer.setPointerCapture(e.pointerId);
    viewer.classList.add('hand-dragging');
  };
  const onViewerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = handDragRef.current;
    const viewer = viewerRef.current;
    if (!drag || !viewer) return;
    viewer.scrollLeft = drag.sl - (e.clientX - drag.x);
    viewer.scrollTop = drag.st - (e.clientY - drag.y);
  };
  const endHandDrag = () => {
    handDragRef.current = null;
    viewerRef.current?.classList.remove('hand-dragging');
  };

  const pastDepth = pastRef.current.length;
  const futureDepth = futureRef.current.length;
  const zoomOptions = ZOOM_STEPS.includes(scale) ? ZOOM_STEPS : [...ZOOM_STEPS, scale].sort((a, b) => a - b);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">PDF Engine Editor</div>
        <label className="open-btn">
          Open PDF
          <input type="file" accept="application/pdf,.pdf" className="visually-hidden" aria-label="Open a PDF file" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = '';
          }} />
        </label>
        <span className="file-name">{session ? session.name : 'No file open'}</span>

        <div className="mode-pill" role="group" aria-label="Interaction mode">
          <button data-testid="mode-select" aria-pressed={mode === 'select'} title="Select mode (V) — click text to select its run" onClick={() => switchMode('select')}>Select</button>
          <button data-testid="mode-edit" aria-pressed={mode === 'edit'} title="Edit Text mode (T) — click text to edit it in place" onClick={() => switchMode('edit')}>Edit Text</button>
          <button data-testid="mode-hand" aria-pressed={mode === 'hand'} title="Hand mode (H) — drag to scroll" onClick={() => switchMode('hand')}>Hand</button>
        </div>

        <div className="tb-group">
          <button data-testid="undo" disabled={!session || busy || pastDepth === 0} title={`Undo (Ctrl+Z)${pastDepth ? ` — ${pastDepth} step(s) available` : ''}`} onClick={() => void undo()}>↩ Undo</button>
          <button data-testid="redo" disabled={!session || busy || futureDepth === 0} title={`Redo (Ctrl+Y)${futureDepth ? ` — ${futureDepth} step(s) available` : ''}`} onClick={() => void redo()}>↪ Redo</button>
        </div>

        <span className="spacer" />

        <div className="pager">
          <button disabled={!session || pageNow <= 1} onClick={() => gotoPage(pageNow - 1)}>‹ Prev</button>
          <input
            key={pageNow}
            className="page-input"
            data-testid="page-input"
            defaultValue={session ? String(pageNow) : ''}
            disabled={!session}
            aria-label="Page number"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= pageCount && n !== pageNow) gotoPage(n);
              else e.target.value = String(pageNow);
            }}
          />
          <span>{session ? `/ ${pageCount}` : '—'}</span>
          <button disabled={!session || pageNow >= pageCount} onClick={() => gotoPage(pageNow + 1)}>Next ›</button>
        </div>

        <div className="zoom-cluster">
          <button data-testid="zoom-out" disabled={!session || scale <= 0.25} title="Zoom out" onClick={() => zoomStep(-1)}>−</button>
          <select data-testid="zoom-select" value={scale} disabled={!session} aria-label="Zoom level"
            onChange={(e) => manualZoom(Number(e.target.value))}>
            {zoomOptions.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
          <button data-testid="zoom-in" disabled={!session || scale >= 4} title="Zoom in" onClick={() => zoomStep(1)}>+</button>
          <button data-testid="fit-width" disabled={!session} aria-pressed={fitMode === 'width'} title="Fit the page width to the viewer" onClick={() => applyFit('width')}>Fit Width</button>
          <button data-testid="fit-page" disabled={!session} aria-pressed={fitMode === 'page'} title="Fit the whole page in the viewer" onClick={() => applyFit('page')}>Fit Page</button>
        </div>

        <div className="tb-group">
          <button data-testid="download-top" disabled={!session || session.edits.length === 0} onClick={download}>Download</button>
          <button disabled={!session} title="Discard all edits and return to the file you opened first" onClick={() => void reset()}>Reset</button>
        </div>
      </header>

      <div className="main">
        <div
          className={`viewer${mode === 'hand' ? ' hand' : ''}`}
          ref={viewerRef}
          onPointerDown={onViewerPointerDown}
          onPointerMove={onViewerPointerMove}
          onPointerUp={endHandDrag}
          onPointerCancel={endHandDrag}
          onDoubleClick={() => { if (selectionRef.current && modeRef.current !== 'hand') requestInlineEdit(selectionRef.current); }}
        >
          {/* pagesHost is managed imperatively (canvas + text layers);
              React must never render children into it. */}
          <div className="pages-host" ref={pagesHostRef} data-testid="viewer" />
          {!session && (
            <div className="empty">
              <h1>Edit PDF text, entirely in your browser</h1>
              <p>Open a PDF to begin. Your file is processed locally on this device — it is never uploaded, and this app has no backend, no accounts, and no tracking.</p>
              <p className="limits">Supported: replacing existing text runs (or a fragment of a run) in Latin-script documents when the engine can prove the edit is safe. Arabic/Urdu editing, cross-run selections, and scanned/image-only pages are refused with an explanation — never silently faked.</p>
            </div>
          )}
        </div>

        <aside className="panel">
          <h2>Selection &amp; edit</h2>
          {!selection && <p className="hint">In Select mode, click text to select its run, or drag across part of a run to edit just that fragment. In Edit Text mode, clicking (or pressing Enter/F2 on a selection) opens the in-place editor on the page itself. Only text that maps exactly to an engine run can be selected.</p>}
          {selection && (
            <div className="sel-info">
              <div><strong>Page</strong> {selection.target.pageIndex + 1} · <strong>run</strong> #{selection.target.runOrdinal} · <strong>operator</strong> {selection.target.operator}</div>
              <div className="sel-text">{selection.mode === 'whole-run' ? selection.target.runText : `Fragment: ${JSON.stringify(selection.fragment!.text)} of ${JSON.stringify(selection.target.runText)}`}</div>
              <div className="mode-row">
                <label><input type="radio" checked={selection.mode === 'whole-run'} onChange={() => setSelection({ target: selection.target, mode: 'whole-run' })} /> Whole run</label>
                <label><input type="radio" checked={selection.mode === 'fragment'} disabled={!selection.fragment && selection.mode !== 'fragment'} onChange={() => selection.fragment && setSelection({ ...selection, mode: 'fragment' })} /> Fragment (drag-select part of the run)</label>
              </div>
              <label className="repl-label">Replacement text
                <input data-testid="replacement" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
              </label>
              <button className="apply" data-testid="apply" disabled={busy} onClick={() => void applyEdit()}>{busy ? 'Applying…' : 'Apply edit'}</button>
            </div>
          )}

          <h2>Document</h2>
          <div className="doc-actions">
            <button data-testid="download" disabled={!session || session.edits.length === 0} onClick={download}>Download edited PDF</button>
            <button disabled={!session || session.edits.length === 0} onClick={() => void reopenExported()}>Open exported copy</button>
            <button disabled={!session} onClick={() => void reset()}>Reset to original</button>
          </div>
          {session && session.edits.length > 0 && (
            <ol className="edits">{session.edits.map((e, i) => <li key={i}>{e}</li>)}</ol>
          )}
          {session && mapping.unmapped.length > 0 && (
            <details className="unmapped">
              <summary>{mapping.unmapped.length} run(s) not safely editable</summary>
              <ul>{mapping.unmapped.slice(0, 12).map((u, i) => <li key={i}>p{u.pageIndex + 1}#{u.runOrdinal}: {u.reason}</li>)}</ul>
            </details>
          )}

          <h2>Status</h2>
          <div className="status" data-testid="status">
            {status.map((s, i) => <div key={i} className={`status-${s.kind}`}>{s.text}</div>)}
          </div>
        </aside>
      </div>

      <footer className="foot">
        Browser-local by design: no uploads, no server processing, no analytics. Engine refusals are final — an edit that cannot be proven safe is not applied.
        Known limits: no reflow (longer replacements can overlap following text; the engine reports width changes), single-run fragments only, Latin script only in this milestone.
        Undo history holds at most {HISTORY_MAX} steps and about {Math.round(HISTORY_BUDGET_BYTES / 1048576)} MB of document states; the oldest steps are dropped first.
      </footer>
    </div>
  );
}
