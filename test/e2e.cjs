// Browser E2E for PDF Engine Editor.
// Serves dist/ under https://editor.local/ via CDP Fetch interception
// (sandbox loopback is blocked by Local Network Access policy), drives
// the real UI in headless Chromium, and asserts: upload -> select ->
// edit -> preview, download byte capture, Arabic refusal, reset, zero
// console errors, and zero network requests outside the app origin.
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
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('Reset to the original')`, 'reset status');
  await waitFor(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`, 'BROWN back after reset');
  check('reset restores the original document', true);

  // Arabic replacement must refuse and change nothing.
  check('re-select BROWN after reset', await selectSpan('BROWN'));
  await waitFor(`document.querySelector('[data-testid="replacement"]')?.value === 'BROWN'`, 'panel refilled');
  await setReplacement('أحمر');
  await ev(`document.querySelector('[data-testid="apply"]').click()`);
  await waitFor(`document.querySelector('[data-testid="status"]')?.textContent.includes('script-not-supported-in-this-phase')`, 'arabic refusal status');
  check('Arabic replacement refuses with the script-gate reason', true);
  check('document unchanged after the refusal', await ev(`[...document.querySelectorAll('.textLayer span')].some(s => s.textContent === 'BROWN')`));

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
