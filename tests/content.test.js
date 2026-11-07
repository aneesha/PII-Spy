import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPasteGuard } from '../src/content/guard.js';
import { captureCursorState, insertTextAtSnapshot, isSnapshotValid } from '../src/content/editor.js';
import { createGuardDialog } from '../src/content/modal.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { html = '<textarea>hello WORLD!</textarea>', timeoutMs, enabled = true } = {}) {
  const dom = new JSDOM(html, { url: 'https://chatgpt.com/' });
  const { window } = dom;
  const target = window.document.querySelector('textarea,input,[contenteditable]');
  if (target?.setSelectionRange && target.type !== 'email') target.setSelectionRange(6, 11);
  let resolveScan;
  let rejectScan;
  const request = new Promise((resolve, reject) => { resolveScan = resolve; rejectScan = reject; });
  const messages = [];
  const dialogs = [];
  let storageListener;
  const chrome = {
    runtime: { sendMessage(message) { messages.push(message); return request; } },
    storage: {
      local: { get: async () => ({ enabled }) },
      onChanged: { addListener(callback) { storageListener = callback; }, removeListener() {} },
    },
  };
  const guard = createPasteGuard({ window, chrome, timeoutMs,
    showDialog(options) {
      const dialog = { options, state: 'scanning', closed: false,
        close() { this.closed = true; },
        setStatus(message) { this.status = message; },
        showReview(entities) { this.state = 'review'; this.entities = entities; },
        showError(message, options = {}) { this.state = 'error'; this.error = message; this.allowOriginal = options.allowOriginal !== false; },
      };
      dialogs.push(dialog);
      return dialog;
    },
  });
  t.after(() => { guard.destroy(); window.close(); });
  function paste(text, element = target) {
    const event = new window.Event('paste', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type) => type === 'text/plain' ? text : '<b>hidden@example.com</b>' } });
    element.dispatchEvent(event);
    return event;
  }
  return { window, target, paste, messages, dialogs, resolveScan, rejectScan,
    setEnabled(value) { storageListener({ enabled: { newValue: value } }, 'local'); } };
}

test('blocks paste synchronously before the page sees it; inserts a clean result at the saved selection', async (t) => {
  const f = fixture(t);
  let hostSawPaste = false;
  f.target.addEventListener('paste', () => { hostSawPaste = true; });
  const event = f.paste('safe');
  assert.equal(event.defaultPrevented, true);
  assert.equal(hostSawPaste, false);
  assert.equal(f.target.value, 'hello WORLD!');
  assert.equal(f.messages[0].target, 'background');
  f.target.setSelectionRange(0, 0);
  f.resolveScan({ ok: true, entities: [] });
  await tick();
  assert.equal(f.target.value, 'hello safe!');
  assert.equal(f.target.selectionStart, 10);
});

test('requires a user choice for PII, including an explicit original paste', async (t) => {
  const f = fixture(t);
  f.paste('jane@example.com');
  f.resolveScan({ ok: true, entities: [{ start: 0, end: 16, label: 'email' }] });
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
  assert.equal(f.dialogs[0].state, 'review');
  f.dialogs[0].options.onConfirm('[EMAIL]');
  assert.equal(f.target.value, 'hello [EMAIL]!');
});

test('scan errors and invalid offsets fail closed and offer an explicit original choice', async (t) => {
  const f = fixture(t);
  f.paste('sensitive');
  f.resolveScan({ ok: true, entities: [{ start: 0, end: 500, label: 'person' }] });
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
  assert.equal(f.dialogs[0].state, 'error');
  assert.equal(f.dialogs[0].allowOriginal, true);
  f.dialogs[0].options.onConfirm('sensitive');
  assert.equal(f.target.value, 'hello sensitive!');
});

test('a runtime rejection does not paste unchecked text', async (t) => {
  const f = fixture(t);
  f.paste('sensitive');
  f.rejectScan(new Error('Extension context invalidated.'));
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
  assert.equal(f.dialogs[0].state, 'error');
});

test('cancel and rapid pastes cannot allow a late scan to insert text', async (t) => {
  const f = fixture(t);
  f.paste('first');
  const second = f.paste('second');
  assert.equal(second.defaultPrevented, true);
  assert.equal(f.messages.length, 1);
  f.dialogs[0].options.onCancel();
  f.resolveScan({ ok: true, entities: [] });
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
});

test('a paste while the dialog has focus cannot expose clipboardData to page listeners', (t) => {
  const f = fixture(t);
  f.paste('first');
  let observed = false;
  f.window.document.addEventListener('paste', () => { observed = true; }, true);
  const event = f.paste('second', f.window.document.body);
  assert.equal(event.defaultPrevented, true);
  assert.equal(observed, false);
  assert.equal(f.messages.length, 1);
});

test('timeout leaves the paste blocked and ignores a late clean result', async (t) => {
  const f = fixture(t, { timeoutMs: 5 });
  f.paste('sensitive');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.dialogs[0].state, 'error');
  f.resolveScan({ ok: true, entities: [] });
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
});

test('a changed or removed destination is never overwritten', async (t) => {
  const f = fixture(t);
  f.paste('sensitive');
  f.target.value = 'new draft';
  f.resolveScan({ ok: true, entities: [] });
  await tick();
  assert.equal(f.target.value, 'new draft');
  assert.equal(f.dialogs[0].allowOriginal, false);
  f.target.remove();
  f.dialogs[0].options.onConfirm('sensitive');
  assert.equal(f.target.value, 'new draft');
});

test('noneditable controls are untouched and disabled protection permits native paste', async (t) => {
  const f = fixture(t);
  await tick();
  f.setEnabled(false);
  assert.equal(f.paste('safe').defaultPrevented, false);
  f.setEnabled(true);
  assert.equal(f.paste('safe', f.window.document.body).defaultPrevented, false);
  assert.equal(f.messages.length, 0);
});

test('a setting change cancels a pending paste', async (t) => {
  const f = fixture(t);
  f.paste('sensitive');
  f.setEnabled(false);
  f.resolveScan({ ok: true, entities: [] });
  await tick();
  assert.equal(f.target.value, 'hello WORLD!');
  assert.equal(f.dialogs[0].closed, true);
});

test('fallback uses the correct native input setter and emits a composed input event', (t) => {
  const f = fixture(t, { html: '<input value="hello WORLD!">' });
  const snapshot = captureCursorState({ target: f.target });
  Object.defineProperty(f.target, 'value', {
    get() { return Object.getOwnPropertyDescriptor(f.window.HTMLInputElement.prototype, 'value').get.call(this); },
    set() { throw new Error('React-style own setter must be bypassed.'); },
  });
  let inputEvent;
  f.target.addEventListener('input', (event) => { inputEvent = event; });
  assert.equal(insertTextAtSnapshot(snapshot, 'safe').ok, true);
  assert.equal(f.target.value, 'hello safe!');
  assert.equal(inputEvent.inputType, 'insertFromPaste');
  assert.equal(inputEvent.composed, true);
});

test('rich editor fallback inserts text, never clipboard HTML, into the saved range', (t) => {
  const f = fixture(t, { html: '<div contenteditable="true"><b>Hello</b> WORLD!</div>' });
  const textNode = f.target.lastChild;
  const range = f.window.document.createRange();
  range.setStart(textNode, 1);
  range.setEnd(textNode, 6);
  f.window.getSelection().addRange(range);
  const snapshot = captureCursorState({ target: f.target });
  assert.equal(insertTextAtSnapshot(snapshot, '<img src=x onerror=alert(1)>').ok, true);
  assert.equal(f.target.textContent, 'Hello <img src=x onerror=alert(1)>!');
  assert.equal(f.target.querySelector('img'), null);
  assert.equal(f.target.querySelector('b').textContent, 'Hello');
});

test('changing an editing host to noneditable invalidates its snapshot', (t) => {
  const f = fixture(t, { html: '<div contenteditable="true">hello</div>' });
  const range = f.window.document.createRange();
  range.selectNodeContents(f.target);
  range.collapse(false);
  f.window.getSelection().addRange(range);
  const snapshot = captureCursorState({ target: f.target });
  assert.equal(isSnapshotValid(snapshot), true);
  f.target.setAttribute('contenteditable', 'false');
  assert.equal(isSnapshotValid(snapshot), false);
});

test('an identical rich-editor rerender cannot move a saved live Range to a different cursor position', (t) => {
  const f = fixture(t, { html: '<div contenteditable="true">hello world</div>' });
  const range = f.window.document.createRange();
  range.setStart(f.target.firstChild, 6);
  range.collapse(true);
  f.window.getSelection().addRange(range);
  const snapshot = captureCursorState({ target: f.target });
  f.target.innerHTML = f.target.innerHTML;
  assert.equal(isSnapshotValid(snapshot), false);
  assert.equal(insertTextAtSnapshot(snapshot, 'sensitive').ok, false);
  assert.equal(f.target.textContent, 'hello world');
});

test('host focus handlers cannot reroute a paste into another editor', (t) => {
  const f = fixture(t, { html: '<input value="hello WORLD!"><textarea>other draft</textarea>' });
  const input = f.window.document.querySelector('input');
  const other = f.window.document.querySelector('textarea');
  input.setSelectionRange(6, 11);
  const snapshot = captureCursorState({ target: input });
  let commandCalled = false;
  f.window.document.execCommand = () => { commandCalled = true; return true; };
  input.addEventListener('focus', () => other.focus());
  assert.equal(insertTextAtSnapshot(snapshot, 'sensitive').ok, false);
  assert.equal(commandCalled, false);
  assert.equal(input.value, 'hello WORLD!');
  assert.equal(other.value, 'other draft');
});

test('host focus handlers that change a draft invalidate the paste before insertion', (t) => {
  const f = fixture(t);
  const snapshot = captureCursorState({ target: f.target });
  f.target.addEventListener('focus', () => { f.target.value = 'changed on focus'; });
  assert.equal(insertTextAtSnapshot(snapshot, 'sensitive').ok, false);
  assert.equal(f.target.value, 'changed on focus');
});

test('a fieldset becoming disabled invalidates an input snapshot', (t) => {
  const f = fixture(t, { html: '<fieldset><input value="hello WORLD!"></fieldset>' });
  const snapshot = captureCursorState({ target: f.target });
  assert.equal(isSnapshotValid(snapshot), true);
  f.target.closest('fieldset').disabled = true;
  assert.equal(isSnapshotValid(snapshot), false);
});

test('selection-incompatible text controls are blocked with a clear unsupported-editor message', (t) => {
  const f = fixture(t, { html: '<input type="email" value="jane@example.com">' });
  assert.equal(f.paste('jane@example.com').defaultPrevented, true);
  assert.equal(f.messages.length, 0);
  assert.equal(f.dialogs[0].allowOriginal, false);
});

test('modal safely renders malicious clipboard text, previews selected redactions, and supports Escape', (t) => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  let shadow;
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  const text = '<img src=x onerror=alert(1)> jane@example.com';
  let confirmed;
  let canceled = false;
  const dialog = createGuardDialog({ document, originalText: text,
    onConfirm(value) { confirmed = value; }, onCancel() { canceled = true; dialog.close(); } });
  dialog.showReview([{ start: text.indexOf('jane'), end: text.length, label: 'email' }]);
  assert.equal(dialog.host.shadowRoot, null);
  assert.equal(shadow.querySelector('img'), null);
  assert.equal(shadow.querySelector('[data-preview]').textContent, '<img src=x onerror=alert(1)> [EMAIL]');
  const checkbox = shadow.querySelector('input');
  checkbox.checked = false;
  checkbox.dispatchEvent(new dom.window.Event('change'));
  shadow.querySelector('[data-action="redact"]').click();
  assert.equal(confirmed, text);
  shadow.querySelector('dialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(canceled, true);
  assert.equal(document.querySelector('#pii-spy-guard'), null);
});
