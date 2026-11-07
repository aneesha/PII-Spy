// This test uses the real background, offscreen document, ONNX model and UI.
// Install the Playwright Chromium build first: npx playwright install chromium --no-shell
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const extensionPath = resolve('dist');
await access(join(extensionPath, 'manifest.json'));
const profile = await mkdtemp(join(tmpdir(), 'pii-spy-browser-'));
const protectedFixtureUrl = 'https://chatgpt.com/pii-spy-local-test';
const remoteRequests = [];
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    executablePath: process.env.PII_SPY_CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url()) && request.url() !== protectedFixtureUrl) remoteRequests.push(request.url());
  });
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.addInitScript(() => {
    const roots = new WeakMap();
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (settings) {
      const root = attachShadow.call(this, settings);
      roots.set(this, root);
      return root;
    };
    window.__guardRoot = () => roots.get(document.querySelector('#pii-spy-guard'));
  });
  await page.goto(`chrome-extension://${extensionId}/test-editor.html`);
  const prepared = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'PREPARE_MODEL' }));
  assert.equal(prepared?.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.status.state, 'ready');
  const response = await page.evaluate(() => chrome.runtime.sendMessage({
    target: 'background',
    type: 'SCAN_PII',
    requestId: 'real-model-smoke',
    text: 'Contact Jane Smith at jane@example.com.',
  }));
  assert.equal(response?.ok, true, JSON.stringify(response));
  assert.ok(response.entities.some((entity) => entity.label === 'email'), 'The real local detector must identify the email.');
  assert.ok(response.entities.some((entity) => entity.label === 'person' && entity.source === 'model'), 'GLiNER must identify the contextual person entity in the fixture.');

  const status = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATUS' }));
  assert.equal(status.ok, true);
  assert.equal(status.status.state, 'ready');

  const pastePrevented = await page.evaluate(() => {
    const editor = document.getElementById('test-textarea');
    editor.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'Contact Jane Smith at jane@example.com.');
    const paste = new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true });
    editor.dispatchEvent(paste);
    return paste.defaultPrevented;
  });
  assert.equal(pastePrevented, true);
  await page.waitForFunction(() => Boolean(window.__guardRoot()?.querySelector('[data-action="redact"]')), null, { timeout: 120_000 });
  assert.equal(await page.inputValue('#test-textarea'), '');
  assert.ok(await page.evaluate(() => window.__guardRoot().querySelectorAll('[data-entity-index]').length > 0));
  if (process.env.PII_SPY_SCREENSHOT) await page.screenshot({ path: process.env.PII_SPY_SCREENSHOT });
  await page.evaluate(() => window.__guardRoot().querySelector('[data-action="redact"]').click());
  const pasted = await page.inputValue('#test-textarea');
  assert.doesNotMatch(pasted, /jane@example\.com/);
  assert.match(pasted, /\[EMAIL\]/);

  // Fulfill a protected-site URL entirely inside Playwright. This verifies the
  // registered document_start content script against a restrictive host CSP,
  // without visiting ChatGPT or exposing fixture text to a server.
  await context.route(protectedFixtureUrl, (route) => route.fulfill({
    contentType: 'text/html',
    headers: { 'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none';" },
    body: '<!doctype html><html><body><textarea id="editor"></textarea></body></html>',
  }));
  const protectedPage = await context.newPage();
  await protectedPage.goto(protectedFixtureUrl);
  const intercepted = await protectedPage.evaluate(() => {
    const editor = document.getElementById('editor');
    editor.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'Reach Jane Smith at jane@example.com.');
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true });
    editor.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(intercepted, true, 'The real document_start content script must intercept on the protected site.');
  const cdp = await context.newCDPSession(protectedPage);
  let redactNode;
  const deadline = Date.now() + 120_000;
  while (!redactNode && Date.now() < deadline) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const findRedact = (node) => {
      if (node.localName === 'button') {
        const attributes = Object.fromEntries(Array.from({ length: (node.attributes?.length || 0) / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
        if (attributes['data-action'] === 'redact') return node;
      }
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = findRedact(child);
        if (found) return found;
      }
      return null;
    };
    redactNode = findRedact(root);
    if (!redactNode) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(redactNode, 'A real scan must open the review UI despite the host CSP.');
  assert.equal(await protectedPage.inputValue('#editor'), '');
  if (process.env.PII_SPY_SCREENSHOT) await protectedPage.screenshot({ path: process.env.PII_SPY_SCREENSHOT.replace(/\.png$/, '-strict-csp.png') });
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: redactNode.nodeId });
  await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
  const protectedPasted = await protectedPage.inputValue('#editor');
  assert.doesNotMatch(protectedPasted, /jane@example\.com/);
  assert.match(protectedPasted, /\[EMAIL\]/);
  assert.deepEqual(remoteRequests, [], 'Inference and tokenization must use only bundled extension assets.');
  console.log('Real extension smoke passed: background → offscreen → local ONNX → review modal → redacted paste; strict host CSP also passed; no remote inference requests.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
