// Browser E2E for PDF Engine Editor.
// Serves dist/ under https://editor.local/ via CDP Fetch interception
// (sandbox loopback is blocked by Local Network Access policy), drives
// the real UI in headless Chromium, and asserts: upload -> select ->
// edit -> preview, download byte capture, Arabic refusal, reset,
// undo/redo, pager + scroll-spy, fit zoom, inline editing (commit /
// refusal-stays-open / Escape), rotated-page and cropped-page flows —
// including reset AFTER opening the exported copy, which must still
// return to the first-opened file — zero console errors, and zero
// network requests outside the app origin.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ORIGIN = 'https://editor.local';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9333, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  try { execSync('fuser -k 9333/tcp 2>/dev/null; sleep 1'); } catch { /* nothing on the port */ }
  const profile = '/tmp/pee-e2e-profile-' + Date.now();
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn('/opt/meta-chromium/chrome', [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
    '--ignore-certificate-errors', "--remote-allow-origins=*", '--no-first-run',
    '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);

  let version;
  for (let i = 0; i < 40; i++) { try { version = await getJson('/json/version'); break; } catch { await sleep(500); } }
  if (!version) throw new Error('chromium CDP did not come up');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); let pageSession = null;
  const requests = []; const consoleErrors = [];
  const send = (method, params = {}, sessionId) => new Promise((r) => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params;
      if (targetInfo.type === 'page' && !pageSession) pageSession = sessionId;
      await send('Fetch.enable', { patterns: [{ urlPattern: ORIGIN + '/*' }] }, sessionId).catch(() => {});
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params; const sid = m.sessionId;
      try {
        const url = new URL(request.url); let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/index.html';
        const file = path.join(DIST, rel);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: MIME[path.extname(file)] || 'application/octet-stream' }], body: fs.readFileSync(file).toString('base64') }, sid);
        } else {
          await send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: Buffer.from('nf').toString('base64') }, sid);
        }
      } catch { try { await send('Fetch.continueRequest', { requestId }, sid); } catch {} }
      return;
    }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === pageSession) {
      requests.push(m.params.request.url);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.sessionId === pageSession && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === pageSession) {
      consoleErrors.push('exception: ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200));
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  for (let i = 0; i < 60 && !pageSession; i++) await sleep(250);
  if (!pageSession) throw new Error('no page session');
  const S = pageSession;
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Network.enable', {}, S);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, S).catch(() => {});
  await send('DOM.enable', {}, S);
  await send('Page.navigate', { url: ORIGIN + '/' }, S);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || 'eval error').slice(0, 300));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, label, timeout = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(expr)) return; await sleep(400); }
    throw new Error('timeout waiting for: ' + label);
  };
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

  if (process.env.E2E_DEBUG) {
    await sleep(9000);
    console.log('TITLE:', await ev('document.title'));
    console.log('BODY:', await ev('document.body ? document.body.innerText.slice(0, 300) : "no body"'));
    console.log('REQLOG:', requests.slice(0, 14).join(' | '));
    console.log('CONSOLE:', consoleErrors.join(' || ') || 'none');
  }
  await waitFor(`document.querySelector('.brand')?.textContent.includes('PDF Engine Editor')`, 'app boot');
  check('app boots under its own origin', true);

  // Upload writer.pdf through the real file input.
  const docRes = await send('DOM.getDocument', {}, S);
  const rootId = docRes.result.root.nodeId;
  const inputRes = await send('DOM.querySelector', { nodeId: rootId, selector: 'input[type="file"]' }, S);
  await send('DOM.setFileInputFiles', { nodeId: inputRes.result.nodeId, files: [path.join(ROOT, 'test/fixtures/writer.pdf')] }, S);
  try {
    await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('editable run')`, 'mapping status');
  } catch (e) {
    console.log('STATUS DUMP:', await ev(`document.querySelector('[data-testid="status"]')?.textContent.slice(0, 300)`));
    console.log('PAGES:', await ev(`document.querySelectorAll('.page-wrap').length`), 'SPANS:', await ev(`document.querySelectorAll('.textLayer span').length`));
    console.log('FILENAME:', await ev(`document.querySelector('.file-name')?.textContent`));
    console.log('CONSOLE:', consoleErrors.join(' || ') || 'none');
    throw e;
  }
  check('document opens and runs map', true);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN span rendered');
  check('page renders with a text layer', true);

  const selectSpan = (text) => ev(`(() => {
    const span = [...document.querySelectorAll('.textLayer span')].find(s => s.textContent === ${JSON.stringify(text)});
    if (!span) return false;
    const sel = window.getSelection(); const range = document.createRange();
    range.setStart(span.firstChild, 1); range.setEnd(span.firstChild, 1);
    sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  })()`);
  const setReplacement = (value) => ev(`(() => {
    const input = document.querySelector('[data-testid="replacement"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  const uploadFixture = async (name) => {
    const d = await send('DOM.getDocument', {}, S);
    const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: 'input[type="file"]' }, S);
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path.join(ROOT, 'test/fixtures', name)] }, S);
  };
  const setInlineValue = (value) => ev(`(() => {
    const input = document.querySelector('[data-testid="inline-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  const inlineKey = (key) => ev(`(() => {
    const input = document.querySelector('[data-testid="inline-input"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`);
  const statusText = () => ev(`document.querySelector('[data-testid="status"]')?.textContent ?? ''`);

  check('select BROWN run', await selectSpan('BROWN'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'BROWN'`, 'selection panel filled');
  check('selection panel shows the mapped run', true);
  await setReplacement('RED');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Edited via fallback-font')`, 'edit success status');
  check('whole-run edit applies via fallback-font', true);
  // Download: capture the exported blob bytes for offline verification.
  const b64 = await ev(`(async () => {
    window.__cap = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__blob = blob; return orig(blob); };
    document.querySelector('[data-testid="download"]').click();
    await new Promise(r => setTimeout(r, 600));
    const buf = await window.__blob.arrayBuffer();
    let s = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(s);
  })()`);
  fs.mkdirSync(path.join(ROOT, 'test/out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test/out/e2e-export.pdf'), Buffer.from(b64, 'base64'));
  check('download produces a PDF byte stream', b64.length > 1000, `${Math.round(b64.length * 3 / 4)} bytes`);


  try {
    await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'RED')`, 'RED in preview', 20000);
  } catch (e) {
    console.log('SPANS NOW:', await ev(`[...document.querySelectorAll('.textLayer span')].slice(0, 14).map(s => JSON.stringify(s.textContent)).join(' | ')`));
    console.log('HAS RED (any span):', await ev(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'RED')`),
      '| TOTAL SPANS:', await ev(`document.querySelectorAll('.textLayer span').length`),
      '| LAST SPANS:', await ev(`[...document.querySelectorAll('.textLayer span')].slice(-4).map(s => JSON.stringify(s.textContent)).join(' | ')`));
    console.log('PAGES:', await ev(`document.querySelectorAll('.page-wrap').length`));
    console.log('STATUS:', await ev(`document.querySelector('[data-testid="status"]')?.textContent.slice(0, 200)`));
    console.log('CONSOLE:', consoleErrors.join(' || ') || 'none');
    throw e;
  }
  check('preview shows RED and BROWN is gone', await ev(`![...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`));

  // Reset restores the original.
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Reset to original')).click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Reset to writer.pdf')`, 'reset status');
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back after reset');
  check('reset restores the original document', true);
  // The mapping state is set at the END of the reload; selecting before
  // it lands would resolve against the previous document's mapping.
  await waitFor(`document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent.includes('Mapped 30 editable run(s)')`, 'reset reload finished (mapping current)');

  // Regression (found in live testing 2026-10-16): opening the exported
  // copy must NOT replace the session's original. After edit -> open
  // exported copy -> reset, the app must return to writer.pdf with BROWN,
  // not stay on the exported RED document.
  check('re-select BROWN for the export/reset sequence', await selectSpan('BROWN'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'BROWN'`, 'panel refilled (2nd edit)');
  await setReplacement('RED');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  // Wait for the COMMIT (the edits list gains the entry), not the status
  // text: an earlier edit's identical status message is still in the log
  // and would satisfy a text wait instantly, racing the reload-first
  // commit order (session/history advance only after the reload).
  await waitFor(`document.querySelectorAll('.edits li').length === 1`, 'second edit committed');
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Open exported copy')).click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('exported copy is now the open document')`, 'export opened status');
  check('opening the export announces the pinned reset target',
    await ev(`document.querySelector('[data-testid="status"]')?.textContent.includes('still returns to writer.pdf')`));
  try {
    await waitFor(`document.querySelector('.file-name')?.textContent.includes('writer-edited.pdf')`, 'header shows the exported name', 30000);
    await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'RED')`, 'RED visible in the exported doc', 30000);
  } catch (e) {
    console.log('FILE-NAME:', await ev(`document.querySelector('.file-name')?.textContent`));
    console.log('SPANS:', await ev(`[...document.querySelectorAll('.textLayer span')].slice(0, 10).map(s => JSON.stringify(s.textContent)).join(' | ')`));
    console.log('STATUS:', await ev(`document.querySelector('[data-testid="status"]')?.textContent.slice(0, 200)`));
    throw e;
  }
  check('exported copy is the open document (header + RED visible)', true);
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Reset to original')).click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Reset to writer.pdf')`, 'reset-after-export status');
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back after reset-after-export');
  check('reset after opening the export restores the first-opened file',
    await ev(`document.querySelector('.file-name')?.textContent.trim() === 'writer.pdf'`) &&
    await ev(`![...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'RED')`));

  // Arabic replacement must refuse and change nothing.
  await waitFor(`document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent.includes('Mapped 30 editable run(s)')`, 'reset-after-export reload finished (mapping current)');
  check('re-select BROWN after reset', await selectSpan('BROWN'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'BROWN'`, 'panel refilled');
  await setReplacement('أحمر');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('script-not-supported-in-this-phase')`, 'arabic refusal status');
  check('Arabic replacement refuses with the script-gate reason', true);
  check('document unchanged after the refusal', await ev(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`));

  // --- Phase A/B/C additions (2026-10-16) --------------------------------
  // A refused edit must never create a history entry: right after the
  // Arabic refusal above (and a reset before it), Undo/Redo are disabled.
  check('undo/redo stay disabled after a refused edit (no history entry)',
    await ev(`document.querySelector('[data-testid="undo"]').disabled && document.querySelector('[data-testid="redo"]').disabled`));

  // Undo/redo cycle, and a fresh edit clearing the redo stack.
  check('select BROWN for the undo cycle', await selectSpan('BROWN'));
  // The panel reflects the selection via .sel-text; the replacement box
  // still holds the refused Arabic text on purpose (the anti-clobber
  // guard never overwrites typed text for a repeat selection delivery).
  await waitFor(`document.querySelector('.sel-text')?.textContent === 'BROWN'`, 'panel shows the run (undo cycle)');
  await setReplacement('RED');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`!document.querySelector('[data-testid="undo"]').disabled`, 'undo-cycle edit committed (undo enabled)');
  check('undo becomes available after a successful edit', true);
  await ev(`document.querySelector('[data-testid="undo"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('back to 0 applied edit(s)')`, 'undo status');
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back after undo');
  check('undo restores the pre-edit state and offers redo',
    await ev(`!document.querySelector('[data-testid="redo"]').disabled`));
  await ev(`document.querySelector('[data-testid="redo"]').click()`);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'RED')`, 'RED back after redo');
  // Gate the next click on the redo's completion message: spans appear
  // during the reload, while the redo is still marked busy — a click in
  // that window would be (correctly) ignored.
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Redo — the document is back to 1 applied edit(s)')`, 'redo completed');
  check('redo reapplies the edit', true);
  await ev(`document.querySelector('[data-testid="undo"]').click()`);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back (2nd undo)');
  // Spans appear before the load (and its mapping) completes, and the
  // app rightly ignores selections mid-load. The decisive completion
  // signal is the undo's own status line becoming the newest entry
  // (it is emitted after the reload, as the operation's last step).
  await waitFor(`(document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent ?? '').startsWith('Undo —')`, 'undo fully committed');
  check('re-select BROWN for the redo-clearing edit', await selectSpan('BROWN'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'BROWN'`, 'panel filled (BLUE edit)');
  await setReplacement('BLUE');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`!document.querySelector('[data-testid="undo"]').disabled`, 'BLUE edit committed (undo enabled)');
  check('a new edit clears the redo stack', await ev(`document.querySelector('[data-testid="redo"]').disabled`));
  await ev(`document.querySelector('[data-testid="undo"]').click()`);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back (final undo)');

  // Page-number navigation + scroll-spy.
  check('pager starts on page 1', await ev(`document.querySelector('[data-testid="page-input"]').value === '1'`));
  // The harness window is 800px wide (narrow layout): the window is the
  // scroller here. On wide screens the viewer pane scrolls instead; the
  // spy listens to both.
  await ev(`window.scrollTo(0, document.body.scrollHeight)`);
  await waitFor(`document.querySelector('[data-testid="page-input"]').value === '3'`, 'scroll-spy reaches page 3', 20000);
  check('scroll-spy follows manual scrolling', true);
  await ev(`(() => {
    const input = document.querySelector('[data-testid="page-input"]');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  // The commit happens on blur (the Enter handler blurs); navigation is
  // proven by the window scrolling back to page 1 (smooth scroll: wait).
  await waitFor(`window.scrollY < 200`, 'page input navigates back to page 1', 20000);
  check('page-number input navigates', await ev(`document.querySelector('[data-testid="page-input"]').value === '1'`));

  // Fit Width, then back to a discrete zoom.
  const wrapW0 = await ev(`document.querySelector('.page-wrap').offsetWidth`);
  await ev(`document.querySelector('[data-testid="fit-width"]').click()`);
  // Null-safe: the zoom reload briefly empties the pages host.
  await waitFor(`(() => { const w = document.querySelector('.page-wrap'); return !!w && Math.abs(w.offsetWidth - (document.querySelector('.viewer').clientWidth - 48)) <= 8; })()`, 'fit width applied', 30000);
  check('Fit Width fits the page to the viewer', true, `wrap ${wrapW0}px -> ${await ev(`document.querySelector('.page-wrap').offsetWidth`)}px`);
  await ev(`(() => {
    const sel = document.querySelector('[data-testid="zoom-select"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, '1.25');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(`(() => { const w = document.querySelector('.page-wrap'); return !!w && Math.abs(w.offsetWidth - 765) <= 3; })()`, 'zoom restored to 125%', 30000);
  check('manual zoom after fit restores the discrete scale', true);
  await waitFor(`(document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent ?? '').startsWith('Mapped ')`, 'zoom reload finished (mapping current)', 30000);

  // Inline editing: success path with the width estimate visible.
  await ev(`document.querySelector('[data-testid="mode-edit"]').click()`);
  await waitFor(`document.querySelector('[data-testid="mode-edit"]').getAttribute('aria-pressed') === 'true'`, 'edit mode active');
  check('select BROWN in Edit Text mode', await selectSpan('BROWN'));
  await waitFor(`!!document.querySelector('[data-testid="inline-input"]')`, 'inline editor opens on click in Edit mode', 20000);
  check('inline editor is prefilled with the run text',
    await ev(`document.querySelector('[data-testid="inline-input"]').value === 'BROWN'`));
  await waitFor(`(document.querySelector('[data-testid="inline-meta"]')?.textContent ?? '').includes('pt →')`, 'width estimate appears', 20000);
  check('inline width estimate uses the engine numbers',
    await ev(`(document.querySelector('[data-testid="inline-meta"]').textContent).includes('46.9')`),
    await ev(`document.querySelector('[data-testid="inline-meta"]').textContent`));
  await setInlineValue('CRIMSON');
  await inlineKey('Enter');
  await waitFor(`!document.querySelector('[data-testid="inline-input"]')`, 'inline editor closes after a successful commit', 30000);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'CRIMSON')`, 'CRIMSON in the preview', 30000);
  check('inline commit applies through the engine and reloads', true);
  await ev(`document.querySelector('[data-testid="undo"]').click()`);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back after inline undo', 90000);
  await waitFor(`(document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent ?? '').startsWith('Undo —')`, 'inline undo fully committed', 90000);

  // Inline refusal: the editor stays open with the draft + verbatim reason.
  check('re-open the inline editor on BROWN', await selectSpan('BROWN'));
  await waitFor(`!!document.querySelector('[data-testid="inline-input"]')`, 'inline editor reopens', 20000);
  await setInlineValue('أحمر');
  await inlineKey('Enter');
  await waitFor(`(() => { const e = document.querySelector('[data-testid="inline-error"]'); return e && !e.hidden && e.textContent.includes('script-not-supported-in-this-phase'); })()`, 'inline refusal shows the engine reason', 30000);
  check('inline refusal keeps the editor open with the draft intact',
    await ev(`document.querySelector('[data-testid="inline-input"]').value === 'أحمر'`));
  await inlineKey('Escape');
  await waitFor(`!document.querySelector('[data-testid="inline-input"]')`, 'Escape closes the refused editor', 20000);
  check('document unchanged after the inline refusal + Escape',
    await ev(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN') && !document.querySelector('.edits')`));

  // Inline Escape with a dirty draft cancels without touching the bytes.
  check('open the inline editor once more', await selectSpan('BROWN'));
  await waitFor(`!!document.querySelector('[data-testid="inline-input"]')`, 'inline editor opens (Esc test)', 20000);
  await setInlineValue('ZZZZ');
  await inlineKey('Escape');
  await waitFor(`!document.querySelector('[data-testid="inline-input"]')`, 'editor closed after Escape', 20000);
  check('Escape cancels the draft: no edit recorded, text untouched',
    await ev(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`) &&
    !(await statusText()).includes('ZZZZ'));
  await ev(`document.querySelector('[data-testid="mode-select"]').click()`);

  // Phase C: rotated page — text layer aligned with the rotated display,
  // panel edit works, inline editor rotates with the text.
  await uploadFixture('rotate90.pdf');
  await waitFor(`(document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent ?? '').includes('Mapped 2 editable run(s)')`, 'rotate90 mapping (load finished)', 90000);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'Rotated page heading')`, 'rotate90 heading span', 60000);
  check('rotated page: text layer sits on the rotated display (tall span box)',
    await ev(`(() => { const s = [...document.querySelectorAll('.textLayer span')].find(x => x.textContent === 'Rotated page heading'); const r = s.getBoundingClientRect(); return r.height > r.width * 2; })()`));
  check('select the rotated heading', await selectSpan('Rotated page heading'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'Rotated page heading'`, 'rotated panel filled', 60000);
  await setReplacement('Rotated page title');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Edited via')`, 'rotated edit applied', 60000);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'Rotated page title')`, 'rotated preview updated', 60000);
  check('panel edit works on a /Rotate 90 page', true);
  await ev(`document.querySelector('[data-testid="mode-edit"]').click()`);
  await waitFor(`document.querySelector('[data-testid="mode-edit"]').getAttribute('aria-pressed') === 'true'`, 'edit mode (rotated)');
  check('click the rotated body line', await selectSpan('Body line on a ninety degree page'));
  await waitFor(`!!document.querySelector('[data-testid="inline-input"]')`, 'inline editor opens on rotated text', 60000);
  check('inline editor rotates with the page text and stays on it',
    await ev(`(() => {
      const inp = document.querySelector('[data-testid="inline-input"]');
      const ir = inp.getBoundingClientRect();
      const s = [...document.querySelectorAll('.textLayer span')].find(x => x.textContent === 'Body line on a ninety degree page');
      const sr = s.getBoundingClientRect();
      const dx = Math.abs((ir.left + ir.width / 2) - (sr.left + sr.width / 2));
      const dy = Math.abs((ir.top + ir.height / 2) - (sr.top + sr.height / 2));
      return ir.height > ir.width && dx <= 40 && dy <= 40;
    })()`));
  await inlineKey('Escape');
  await ev(`document.querySelector('[data-testid="mode-select"]').click()`);

  // Phase C: cropped page — the visible run maps and edits; the clipped
  // run is honestly reported as not safely editable.
  await uploadFixture('cropped.pdf');
  await waitFor(`(document.querySelector('[data-testid="status"]')?.firstElementChild?.textContent ?? '').includes('Mapped 1 editable run(s)')`, 'cropped mapping (load finished)', 90000);
  check('cropped page: the visible run maps, the clipped run is reported not editable',
    (await statusText()).includes('1 run(s) cannot be mapped safely'));
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'CROPPED visible text')`, 'cropped span', 60000);
  check('select the visible cropped run', await selectSpan('CROPPED visible text'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'CROPPED visible text'`, 'cropped panel filled', 60000);
  await setReplacement('CROPPED edited text');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Edited via')`, 'cropped edit applied', 60000);
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'CROPPED edited text')`, 'cropped preview updated', 60000);
  check('edit applies on a cropped page', true);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(path.join(ROOT, 'test/out/e2e-editor.png'), Buffer.from(shot.result.data, 'base64'));

  const external = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:'));
  check('no network requests outside the app origin', external.length === 0, external.slice(0, 3).join(', ') || `${requests.length} requests, all local`);
  check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
  cleanup();
  if (failed) process.exit(1);
  // Verify the exported bytes with the engine itself (independent process).
  execSync('npx tsx test/verify-export.mts', { cwd: ROOT, stdio: 'inherit' });
  console.log('E2E COMPLETE');
  process.exit(0);
})().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1); });
