import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundController, MAX_TEXT_LENGTH } from '../src/background-controller.js';

function createApi(overrides = {}) {
  const counts = { created: 0, routed: 0 };
  let exists = false;
  const api = {
    runtime: {
      id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      getContexts: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return exists ? [{}] : [];
      },
      sendMessage: async (message) => {
        counts.routed++;
        assert.equal(message.target, 'offscreen');
        return message.type === 'SCAN_PII' ? { ok: true, entities: [] } : { ok: true, status: { state: 'ready' } };
      },
    },
    offscreen: {
      createDocument: async () => { counts.created++; exists = true; },
    },
  };
  Object.assign(api.runtime, overrides.runtime);
  Object.assign(api.offscreen, overrides.offscreen);
  return { api, counts };
}

const sender = { id: 'test-extension', url: 'https://chatgpt.com/c/test', tab: { id: 1 } };
const scan = { type: 'SCAN_PII', requestId: 'one', text: 'Hello world' };

test('concurrent scans create one offscreen document and route individual requests', async () => {
  const { api, counts } = createApi();
  const controller = createBackgroundController(api);
  const results = await Promise.all(Array.from({ length: 8 }, () => controller.handle(scan, sender)));
  assert.equal(counts.created, 1);
  assert.equal(counts.routed, 8);
  assert.ok(results.every((result) => result.ok));
});

test('failed document creation can be retried without retaining a rejected singleton', async () => {
  const { api, counts } = createApi();
  let attempts = 0;
  api.offscreen.createDocument = async () => {
    if (++attempts === 1) throw new Error('failure');
    counts.created++;
  };
  const controller = createBackgroundController(api);
  assert.equal((await controller.handle(scan, sender)).ok, false);
  assert.equal((await controller.handle(scan, sender)).ok, true);
  assert.equal(attempts, 2);
});

test('rejects unrelated sites, extension IDs, and popup scan requests', async () => {
  const { api, counts } = createApi();
  const controller = createBackgroundController(api);
  for (const invalid of [
    { ...sender, id: 'someone-else' },
    { ...sender, url: 'https://chatgpt.com.evil.test/' },
    { ...sender, url: 'http://claude.ai/' },
    { ...sender, url: 'https://example.com/' },
    { ...sender, url: api.runtime.getURL('popup.html') },
    { ...sender, tab: undefined },
  ]) assert.equal((await controller.handle(scan, invalid)).error.code, 'UNAUTHORIZED');
  assert.equal(counts.created, 0);
});

test('only extension UI can prepare the model or read its status', async () => {
  const { api } = createApi();
  const controller = createBackgroundController(api);
  assert.equal((await controller.handle({ type: 'PREPARE_MODEL' }, sender)).ok, false);
  const popup = { id: api.runtime.id, url: api.runtime.getURL('popup.html') };
  assert.equal((await controller.handle({ type: 'PREPARE_MODEL' }, popup)).status.state, 'ready');
  assert.equal((await controller.handle({ type: 'GET_STATUS' }, popup)).ok, true);
  const demo = { id: api.runtime.id, url: api.runtime.getURL('test-editor.html') };
  assert.equal((await controller.handle(scan, demo)).ok, true);
});

test('rejects malformed or excessive clipboard payloads without starting a detector', async () => {
  const { api, counts } = createApi();
  const controller = createBackgroundController(api);
  for (const text of ['', null, {}, 'a'.repeat(MAX_TEXT_LENGTH + 1)]) {
    assert.equal((await controller.handle({ ...scan, text }, sender)).error.code, 'INVALID_TEXT');
  }
  assert.equal(counts.created, 0);
});

test('transport failure, malformed detector responses, and timeouts never return an empty successful scan', async () => {
  for (const sendMessage of [
    async () => { throw new Error('private input must not be returned'); },
    async () => undefined,
    async () => ({ ok: true }),
    async () => new Promise(() => {}),
  ]) {
    const { api } = createApi({ runtime: { sendMessage } });
    const result = await createBackgroundController(api, { timeoutMs: 10 }).handle(scan, sender);
    assert.equal(result.ok, false);
    assert.equal('entities' in result, false);
    assert.doesNotMatch(result.error.message, /private input/);
  }
});
