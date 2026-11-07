import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/popup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../src/popup.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openPopup({ saved = true, set, send } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://extension.test/popup.html' });
  const messages = [];
  const writes = [];
  dom.window.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://pii-spy/${path}`,
      sendMessage: async (message) => {
        messages.push(message);
        return send ? send(message) : { ok: true, status: { state: 'ready' } };
      },
    },
    storage: { local: {
      get: async () => ({ enabled: saved }),
      set: async (value) => { writes.push(value); if (set) await set(value); },
    } },
  };
  dom.window.eval(script);
  await settle();
  return { dom, document: dom.window.document, messages, writes };
}

test('popup reflects saved protection and actual detector readiness', async () => {
  const { dom, document, messages } = await openPopup({ saved: false });
  try {
    assert.equal(document.getElementById('enabled').checked, false);
    assert.equal(document.getElementById('enabled').disabled, false);
    assert.match(document.getElementById('protection-detail').textContent, /Protection is off/);
    assert.match(document.getElementById('status').textContent, /Ready/);
    assert.equal(messages[0].type, 'GET_STATUS');
    assert.equal(document.getElementById('test-editor').href, 'chrome-extension://pii-spy/test-editor.html');
  } finally { dom.window.close(); }
});

test('changing protection saves the setting and explains how pastes behave', async () => {
  const { dom, document, writes } = await openPopup();
  try {
    const toggle = document.getElementById('enabled');
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await settle();
    assert.deepEqual(writes.map((value) => value.enabled), [false]);
    assert.match(document.getElementById('protection-detail').textContent, /directly to the website/);
  } finally { dom.window.close(); }
});

test('a failed setting save restores the previous toggle and exposes an actionable error', async () => {
  const { dom, document } = await openPopup({ set: async () => { throw new Error('Storage unavailable'); } });
  try {
    const toggle = document.getElementById('enabled');
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await settle();
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, false);
    assert.equal(document.getElementById('error').hidden, false);
    assert.match(document.getElementById('error').textContent, /Could not save/);
  } finally { dom.window.close(); }
});

test('prepare action prevents duplicate initialization and reports setup failures', async () => {
  let finish;
  const { dom, document } = await openPopup({ send: (message) => {
    if (message.type === 'GET_STATUS') return { ok: true, status: { state: 'idle' } };
    return new Promise((resolve) => { finish = resolve; });
  } });
  try {
    const button = document.getElementById('prepare');
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    finish({ ok: false, error: { message: 'Install model assets and reload.' } });
    await settle();
    assert.equal(button.disabled, false);
    assert.match(document.getElementById('status').textContent, /Install model assets/);
  } finally { dom.window.close(); }
});
