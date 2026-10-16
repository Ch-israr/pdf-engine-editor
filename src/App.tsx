import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  applyFragment, applyWholeRun, extractDocument, type EditOutcome, type PageData,
} from './engine-adapter';
import {
  mapRunsToItems, rangeInRun, validateFragment, type MappedTarget, type MappingResult, type ViewerItem,
} from './selection-map';

GlobalWorkerOptions.workerSrc = 'assets/pdfjs/pdf.worker.min.mjs';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

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

interface SelectionState {
  target: MappedTarget;
  mode: 'whole-run' | 'fragment';
  fragment?: { start: number; end: number; text: string };
}

interface StatusEntry { kind: 'ok' | 'error' | 'info'; text: string }

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

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const renderGenRef = useRef(0);
  const itemsRef = useRef<ViewerItem[][]>([]);
  // Key of the selection the panel currently reflects. Browsers deliver
  // selectionchange asynchronously (and sometimes repeatedly); a repeat
  // delivery for the SAME selection must not clobber text the user has
  // already typed into the replacement box.
  const selKeyRef = useRef('');

  const say = useCallback((kind: StatusEntry['kind'], text: string) => {
    setStatus((s) => [{ kind, text }, ...s].slice(0, 30));
  }, []);

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
  const loadIntoViewer = useCallback(async (bytes: Uint8Array) => {
    const gen = ++renderGenRef.current;
    await destroyPdf();
    const host = pagesHostRef.current;
    if (host) host.innerHTML = '';
    setSelection(null);
    selKeyRef.current = '';

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
    setPageNow(1);
    if (!host) return;

    const itemsByPage: ViewerItem[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page: PDFPageProxy = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
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
    const result = mapRunsToItems(extracted.pages, itemsByPage);
    setMapping(result);
    say('info', `Mapped ${result.targets.length} editable run(s); ${result.unmapped.length} run(s) cannot be mapped safely and are not selectable.`);
  }, [destroyPdf, scale, say]);

  // Re-render at a new zoom (keeps the same bytes and edit history).
  useEffect(() => {
    if (session) void loadIntoViewer(session.currentBytes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const openFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      say('error', `File is ${(file.size / 1048576).toFixed(1)} MB — the in-browser limit for this editor is 50 MB.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setSession({ name: file.name, originalName: file.name, originalBytes: bytes, currentBytes: bytes, edits: [] });
    setReplacement('');
    say('info', `Opened ${file.name} (${(file.size / 1024).toFixed(0)} KB). Processing is entirely local — nothing is uploaded.`);
    await loadIntoViewer(bytes);
  }, [loadIntoViewer, say]);

  // Selection → validated target. Runs on every selection change.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const anchorDiv = (sel.anchorNode?.parentElement?.closest?.('[data-item]') ?? null) as HTMLElement | null;
      const focusDiv = (sel.focusNode?.parentElement?.closest?.('[data-item]') ?? null) as HTMLElement | null;
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
      if (sel.isCollapsed) {
        const key = `${target.pageIndex}:${target.runOrdinal}:whole`;
        setSelection({ target, mode: 'whole-run' });
        if (selKeyRef.current !== key) { selKeyRef.current = key; setReplacement(target.runText); }
        return;
      }
      const selText = sel.toString();
      const range = rangeInRun(target, itemsRef.current[pageIndex] ?? [], aItem, sel.anchorOffset, fItem, sel.focusOffset);
      const v = validateFragment(target, range.start, range.end, selText);
      if (!v.ok) {
        say('error', `Fragment selection refused: ${v.reason}.`);
        setSelection({ target, mode: 'whole-run' });
        return;
      }
      const key = `${target.pageIndex}:${target.runOrdinal}:frag:${v.range.start}-${v.range.end}`;
      setSelection({ target, mode: 'fragment', fragment: { start: v.range.start, end: v.range.end, text: selText } });
      if (selKeyRef.current !== key) { selKeyRef.current = key; setReplacement(selText); }
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [mapping, say]);

  const applyEdit = useCallback(async () => {
    if (!session || !selection || busy) return;
    setBusy(true);
    const { target, mode, fragment } = selection;
    let out: EditOutcome;
    try {
      out = mode === 'whole-run'
        ? await applyWholeRun(session.currentBytes, target.pageIndex, target.runOrdinal, target.runText, replacement)
        : await applyFragment(session.currentBytes, {
          pageIndex: target.pageIndex, runOrdinal: target.runOrdinal, matchText: target.runText,
          start: fragment!.start, end: fragment!.end, replacement,
        });
    } catch (e) {
      say('error', `Edit failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
      return;
    }
    if (!out.ok) {
      say('error', `Edit refused (${out.reason}): ${out.detail} — the document was not changed.`);
      setBusy(false);
      return;
    }
    const next: Session = {
      ...session,
      currentBytes: out.bytes!,
      edits: [...session.edits, `${mode === 'whole-run' ? 'Run' : 'Fragment'} p${target.pageIndex + 1}#${target.runOrdinal}: ${JSON.stringify(mode === 'whole-run' ? target.runText : fragment!.text)} → ${JSON.stringify(replacement)} (${out.path})`],
    };
    setSession(next);
    say('ok', `Edited via ${out.path}. ${out.detail}`);
    try {
      await loadIntoViewer(out.bytes!);
    } catch (e) {
      say('error', `The edit was applied but the preview failed to reload: ${e instanceof Error ? e.message : String(e)} — use Download to get the edited file, or Reset.`);
    }
    setBusy(false);
  }, [busy, loadIntoViewer, replacement, say, selection, session]);

  const download = useCallback(() => {
    if (!session) return;
    const blob = new Blob([session.currentBytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = session.name.replace(/\.pdf$/i, '') + '-edited.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    say('ok', 'Downloaded the edited PDF. You can reopen it here with “Open exported copy”.');
  }, [say, session]);

  const reset = useCallback(async () => {
    if (!session) return;
    setSession({ ...session, name: session.originalName, currentBytes: session.originalBytes, edits: [] });
    say('info', `Reset to ${session.originalName} — the file you opened first. All edits were discarded.`);
    await loadIntoViewer(session.originalBytes);
  }, [loadIntoViewer, say, session]);

  const reopenExported = useCallback(async () => {
    if (!session) return;
    const bytes = session.currentBytes;
    // The exported copy becomes the open document, but the session's pinned
    // original (originalName/originalBytes) is deliberately left untouched:
    // Reset must always be able to return to the file the user opened first.
    setSession({ ...session, name: session.name.replace(/\.pdf$/i, '') + '-edited.pdf', currentBytes: bytes, edits: [] });
    say('info', `The exported copy is now the open document. “Reset to original” still returns to ${session.originalName}, the file you opened first.`);
    await loadIntoViewer(bytes);
  }, [loadIntoViewer, say, session]);

  const gotoPage = (p: number) => {
    const host = pagesHostRef.current;
    const el = host?.querySelector(`.page-wrap[data-page="${p}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPageNow(p);
  };

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">PDF Engine Editor</div>
        <label className="open-btn">
          Open PDF
          <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = '';
          }} />
        </label>
        <span className="file-name">{session ? session.name : 'No file open'}</span>
        <span className="spacer" />
        <div className="pager">
          <button disabled={!session || pageNow <= 1} onClick={() => gotoPage(pageNow - 1)}>‹ Prev</button>
          <span>{session ? `Page ${pageNow} / ${pageCount}` : '—'}</span>
          <button disabled={!session || pageNow >= pageCount} onClick={() => gotoPage(pageNow + 1)}>Next ›</button>
        </div>
        <label className="zoom">Zoom
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            {[0.75, 1, 1.25, 1.5, 2].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
        </label>
      </header>

      <div className="main">
        <div className="viewer">
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
          {!selection && <p className="hint">Click text in the document to select its run, or drag across part of a run to edit just that fragment. Only text that maps exactly to an engine run can be selected.</p>}
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
      </footer>
    </div>
  );
}
