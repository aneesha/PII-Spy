import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicUrl = new URL('../public/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', publicUrl), 'utf8'));

test('manifest blocks remote inference code and requests only required capabilities', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['offscreen', 'storage']);
  assert.equal(manifest.background.type, 'module');
  assert.ok(Number(manifest.minimum_chrome_version) >= 116);
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /worker-src 'self';/);
  assert.doesNotMatch(csp, /https?:|unsafe-inline|\*|\b'unsafe-eval'/);
  assert.equal(manifest.web_accessible_resources, undefined, 'The host page must not be given direct access to model assets.');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('capture is registered at document_start only on the intended target sites', () => {
  assert.equal(manifest.content_scripts.length, 1);
  const content = manifest.content_scripts[0];
  assert.equal(content.run_at, 'document_start');
  assert.equal(content.all_frames, true);
  assert.deepEqual([...content.matches].sort(), ['https://chatgpt.com/*', 'https://claude.ai/*']);
  assert.deepEqual(content.js, ['content.js']);
});

test('extension pages use bundled scripts and styles compatible with the CSP', async () => {
  for (const filename of ['popup.html', 'offscreen.html', 'test-editor.html']) {
    const html = await readFile(new URL(filename, publicUrl), 'utf8');
    assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=["']https?:/i, filename);
    assert.doesNotMatch(html, /\bon(?:click|load|error|submit)\s*=/i, filename);
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i, filename);
  }
});
