import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const contentBundle = resolve('dist/content.js');
let browser;

before(async () => {
  assert.ok(existsSync(contentBundle), 'Run npm run build before browser tests.');
  const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.CHROME_PATH || (existsSync(installedChrome) ? installedChrome : undefined);
  browser = await chromium.launch({ executablePath, channel: 'chromium', headless: true });
});

after(async () => {
  await browser?.close();
});

async function createPage(options = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.route('https://chatgpt.com/pii-spy-browser-test', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <textarea id="editor">before after</textarea>
    <input id="input" type="text" value="before after">
    <div id="rich" contenteditable="true">before after</div>
    <button id="other">Other focus target</button>
  </body></html>` }));
  await page.goto('https://chatgpt.com/pii-spy-browser-test');
  await page.evaluate(({ enabled = true, forceFallback = false }) => {
    // Retain the closed shadow root only in this isolated test page. Production
    // code still uses a closed root and never exposes its clipboard UI to JS.
    const roots = new WeakMap();
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (settings) {
      const root = attachShadow.call(this, settings);
      roots.set(this, root);
      return root;
    };
    window.__guardRoot = () => roots.get(document.querySelector('#pii-spy-guard'));
    window.__scanRequests = [];
    window.__pendingScans = [];
    window.__storageListeners = [];
    window.__hostPasteCount = 0;
    window.__hostInputCount = 0;
    const settings = { enabled };
    const storageGet = (keys, callback) => {
      const result = typeof keys === 'object' ? { ...keys, ...settings } : { ...settings };
      if (callback) callback(result);
      return Promise.resolve(result);
    };
    window.chrome = {
      runtime: {
        id: 'pii-spy-test',
        getURL: (path) => `chrome-extension://pii-spy-test/${path}`,
        sendMessage(message, callback) {
          window.__scanRequests.push(message);
          const promise = new Promise((resolve, reject) => window.__pendingScans.push({ resolve, reject }));
          if (callback) promise.then(callback);
          return promise;
        },
      },
      storage: {
        local: { get: storageGet },
        onChanged: {
          addListener: (listener) => window.__storageListeners.push(listener),
          removeListener: () => {},
        },
      },
    };
    if (forceFallback) document.execCommand = () => false;
    document.addEventListener('input', () => window.__hostInputCount++);
    window.addEventListener('paste', (event) => { window.__lastPasteTrusted = event.isTrusted; }, true);
  }, options);
  await page.addScriptTag({ path: contentBundle });
  await page.evaluate(() => {
    // Register after the content script, matching document_start injection.
    window.addEventListener('paste', () => window.__hostPasteCount++, true);
    document.addEventListener('paste', () => window.__hostPasteCount++);
  });
  // Finish the initial storage read before triggering a paste.
  await page.evaluate(() => Promise.resolve());
  return page;
}

async function paste(page, text, { target = 'editor', start = 7, end = start, html } = {}) {
  return page.evaluate(({ text, target, start, end, html }) => {
    const element = document.getElementById(target);
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.setSelectionRange(start, end);
    } else {
      const range = document.createRange();
      range.setStart(element.firstChild, start);
      range.setEnd(element.firstChild, end);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    if (html) clipboardData.setData('text/html', html);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, hostPasteCount: window.__hostPasteCount, value: element.value ?? element.textContent };
  }, { text, target, start, end, html });
}

async function finishScan(page, response) {
  await page.waitForFunction(() => window.__pendingScans.length > 0);
  await page.evaluate((response) => window.__pendingScans.shift().resolve(response), response);
}

async function waitForAction(page, action) {
  await page.waitForFunction((action) => Boolean(window.__guardRoot()?.querySelector(`[data-action="${action}"]`)), action);
}

async function clickAction(page, action) {
  await waitForAction(page, action);
  await page.evaluate((action) => window.__guardRoot().querySelector(`[data-action="${action}"]`).click(), action);
}

async function value(page, target = 'editor') {
  return page.$eval(`#${target}`, (element) => element.value ?? element.textContent);
}

const emailText = 'Email alex@example.com';
const emailEntity = { start: 6, end: 22, label: 'email', score: 0.99, source: 'regex' };

test('blocks propagation synchronously, then inserts a clean payload at the saved selection', async () => {
  const page = await createPage();
  try {
    const synchronous = await paste(page, 'hello ', { start: 7, end: 7 });
    assert.deepEqual(synchronous, { prevented: true, hostPasteCount: 0, value: 'before after' });
    assert.equal(await value(page), 'before after');
    await finishScan(page, { ok: true, entities: [] });
    await page.waitForFunction(() => document.getElementById('editor').value === 'before hello after');
    assert.ok(await page.evaluate(() => window.__hostInputCount > 0));
    assert.equal(await page.evaluate(() => window.__hostPasteCount), 0);
  } finally { await page.close(); }
});

test('intercepts a real Ctrl+V or Cmd+V clipboard paste before native insertion', async () => {
  const page = await createPage();
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' });
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
      const editor = document.getElementById('editor');
      editor.focus();
      editor.setSelectionRange(0, editor.value.length);
    }, emailText);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForFunction(() => window.__pendingScans.length === 1);
    assert.equal(await page.evaluate(() => window.__lastPasteTrusted), true);
    assert.equal(await value(page), 'before after');
    assert.equal(await page.evaluate(() => window.__scanRequests[0].text), emailText);
    assert.equal(await page.evaluate(() => window.__hostPasteCount), 0);
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await clickAction(page, 'redact');
    assert.equal(await value(page), 'Email [EMAIL]');
  } finally { await page.close(); }
});

test('redacts selected PII before the host receives input and strips clipboard HTML', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText, { start: 0, end: 12, html: '<b>alex@example.com</b>' });
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await waitForAction(page, 'redact');
    assert.equal(await value(page), 'before after');
    assert.match(await page.evaluate(() => window.__guardRoot().querySelector('[data-preview]').textContent), /\[EMAIL\]/);
    await clickAction(page, 'redact');
    assert.equal(await value(page), 'Email [EMAIL]');
    assert.equal(await page.evaluate(() => window.__hostPasteCount), 0);
    assert.equal(await page.evaluate(() => document.querySelector('#pii-spy-guard')), null);
  } finally { await page.close(); }
});

test('lets the user keep selected detected values and paste the original explicitly', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText, { start: 0, end: 12 });
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await clickAction(page, 'original');
    assert.equal(await value(page), emailText);
  } finally { await page.close(); }
});

test('updates the redaction preview when a detection is deselected', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText, { start: 0, end: 12 });
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await waitForAction(page, 'redact');
    await page.evaluate(() => window.__guardRoot().querySelector('[data-entity-index="0"]').click());
    assert.equal(await page.evaluate(() => window.__guardRoot().querySelector('[data-preview]').textContent), emailText);
    await clickAction(page, 'redact');
    assert.equal(await value(page), emailText);
  } finally { await page.close(); }
});

test('cancel and Escape restore the original editor without inserting text', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText, { start: 3, end: 6 });
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await waitForAction(page, 'redact');
    await page.keyboard.press('Escape');
    assert.equal(await value(page), 'before after');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'editor');
    assert.deepEqual(await page.$eval('#editor', (element) => [element.selectionStart, element.selectionEnd]), [3, 6]);
    await paste(page, emailText);
    await clickAction(page, 'cancel');
    await finishScan(page, { ok: true, entities: [] });
    assert.equal(await value(page), 'before after');
  } finally { await page.close(); }
});

test('keyboard focus cycles inside the review dialog', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText);
    await finishScan(page, { ok: true, entities: [emailEntity] });
    await waitForAction(page, 'redact');
    assert.equal(await page.evaluate(() => window.__guardRoot().activeElement.dataset.action), 'redact');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => window.__guardRoot().activeElement.dataset.entityIndex), '0');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => window.__guardRoot().activeElement.dataset.action), 'redact');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pii-spy-guard');
    await clickAction(page, 'cancel');
  } finally { await page.close(); }
});

test('scan failures stay blocked until the user explicitly chooses an action', async () => {
  const page = await createPage();
  try {
    await paste(page, emailText, { start: 0, end: 12 });
    await finishScan(page, { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'Model is unavailable.' } });
    await waitForAction(page, 'original');
    assert.equal(await value(page), 'before after');
    assert.match(await page.evaluate(() => window.__guardRoot().textContent), /scan|unavailable|could not/i);
    await clickAction(page, 'cancel');
    assert.equal(await value(page), 'before after');
  } finally { await page.close(); }
});

test('uses the correct native value setter for input and textarea fallbacks', async () => {
  const page = await createPage({ forceFallback: true });
  try {
    for (const target of ['input', 'editor']) {
      await paste(page, 'approved', { target, start: 7, end: 12 });
      await finishScan(page, { ok: true, entities: [] });
      await page.waitForFunction(({ target }) => document.getElementById(target).value === 'before approved', { target });
      assert.deepEqual(await page.$eval(`#${target}`, (element) => [element.selectionStart, element.selectionEnd]), [15, 15]);
    }
  } finally { await page.close(); }
});

test('replaces a saved contenteditable selection with approved plain text', async () => {
  const page = await createPage();
  try {
    await paste(page, '<safe>', { target: 'rich', start: 7, end: 12, html: '<img src=x onerror="window.__didRun=true">' });
    await finishScan(page, { ok: true, entities: [] });
    await page.waitForFunction(() => document.getElementById('rich').textContent === 'before <safe>');
    assert.equal(await page.$eval('#rich', (element) => element.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => window.__didRun), undefined);
  } finally { await page.close(); }
});

test('clipboard and detection strings are rendered as text rather than executable markup', async () => {
  const page = await createPage();
  try {
    const text = '<img src=x onerror="window.__didRun=true"> alex@example.com';
    await paste(page, text);
    const start = text.indexOf('alex@');
    await finishScan(page, { ok: true, entities: [{ ...emailEntity, start, end: text.length, label: '<img src=x onerror="window.__didRun=true">' }] });
    await waitForAction(page, 'redact');
    assert.equal(await page.evaluate(() => window.__guardRoot().querySelectorAll('img,script').length), 0);
    assert.equal(await page.evaluate(() => window.__didRun), undefined);
    await clickAction(page, 'cancel');
  } finally { await page.close(); }
});

test('does not insert into a destination edited while inference was pending', async () => {
  const page = await createPage();
  try {
    await paste(page, 'safe');
    await page.$eval('#editor', (element) => { element.value = 'changed while scanning'; });
    await finishScan(page, { ok: true, entities: [] });
    await page.waitForFunction(() => window.__guardRoot()?.textContent.match(/changed|paste again|destination/i));
    assert.equal(await value(page), 'changed while scanning');
    await clickAction(page, 'cancel');
  } finally { await page.close(); }
});

test('does not insert into a removed destination', async () => {
  const page = await createPage();
  try {
    await paste(page, 'safe');
    await page.$eval('#editor', (element) => element.remove());
    await finishScan(page, { ok: true, entities: [] });
    await page.waitForFunction(() => window.__guardRoot()?.textContent.match(/changed|paste again|destination|available/i));
    assert.equal(await page.locator('#editor').count(), 0);
    assert.equal(await value(page, 'input'), 'before after');
    await clickAction(page, 'cancel');
  } finally { await page.close(); }
});

test('blocks overlapping paste attempts and ignores a late response after cancel', async () => {
  const page = await createPage();
  try {
    await paste(page, 'first');
    const second = await paste(page, 'second');
    assert.equal(second.prevented, true);
    assert.equal(await page.evaluate(() => window.__scanRequests.length), 1);
    await clickAction(page, 'cancel');
    await finishScan(page, { ok: true, entities: [] });
    assert.equal(await value(page), 'before after');
    assert.equal(await page.locator('#pii-spy-guard').count(), 0);
  } finally { await page.close(); }
});

test('paused protection leaves ordinary paste behavior to the browser', async () => {
  const page = await createPage({ enabled: false });
  try {
    const result = await paste(page, emailText);
    assert.equal(result.prevented, false);
    assert.equal(await page.evaluate(() => window.__scanRequests.length), 0);
    assert.ok(result.hostPasteCount > 0);
  } finally { await page.close(); }
});
