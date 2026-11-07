import { captureCursorState, findEditableElement, insertTextAtSnapshot, isSnapshotValid, restoreFocusOnly } from './editor.js';
import { createGuardDialog } from './modal.js';
import { validateEntities } from './redaction.js';

export const SCAN_TIMEOUT_MS = 120_000;

export function createPasteGuard({ window, chrome, css = '', showDialog = createGuardDialog, timeoutMs = SCAN_TIMEOUT_MS }) {
  const document = window.document;
  let enabled = true;
  let pending = null;
  let destroyed = false;
  let settingsRevision = 0;

  function finish(operation, restore = false) {
    if (pending !== operation) return;
    window.clearTimeout(operation.timeout);
    operation.dialog.close();
    pending = null;
    if (restore) restoreFocusOnly(operation.snapshot);
  }

  function openDialog(operation) {
    return showDialog({
      document, css, originalText: operation.text,
      onCancel: () => finish(operation, true),
      onConfirm: (text) => {
        if (pending !== operation) return;
        if (!isSnapshotValid(operation.snapshot)) {
          operation.dialog.showError('The destination changed while scanning. Cancel and paste again.', { allowOriginal: false });
          return;
        }
        // Closing the top-layer dialog makes the editor focusable again.
        operation.dialog.close();
        const result = insertTextAtSnapshot(operation.snapshot, text);
        if (result.ok) finish(operation);
        else {
          operation.dialog = openDialog(operation);
          operation.dialog.showError(result.message, { allowOriginal: false });
        }
      },
    });
  }

  function showScanError(operation, message) {
    if (pending !== operation) return;
    window.clearTimeout(operation.timeout);
    operation.dialog.showError(message);
  }

  async function scan(operation) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: 'background', type: 'SCAN_PII', requestId: operation.requestId, text: operation.text,
      });
      if (pending !== operation || operation.timedOut) return;
      window.clearTimeout(operation.timeout);
      if (response?.ok !== true) throw new Error('SCAN_FAILED');
      const entities = validateEntities(operation.text, response.entities);
      if (!isSnapshotValid(operation.snapshot)) {
        operation.dialog.showError('The destination changed while scanning. Cancel and paste again.', { allowOriginal: false });
      } else if (entities.length) {
        operation.dialog.showReview(entities);
      } else {
        operation.dialog.close();
        const result = insertTextAtSnapshot(operation.snapshot, operation.text);
        if (result.ok) finish(operation);
        else {
          operation.dialog = openDialog(operation);
          operation.dialog.showError(result.message, { allowOriginal: false });
        }
      }
    } catch {
      if (!operation.timedOut) showScanError(operation,
        'The local PII scanner is unavailable. Check the extension setup, or choose explicitly to paste the original.');
    }
  }

  function onPaste(event) {
    if (!enabled || destroyed) return;
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string' || !text.length) return;
    // The dialog's focused buttons are noneditable, but a second native paste still
    // carries clipboardData. Keep it away from page capture listeners as well.
    if (pending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pending.dialog.setStatus('Finish or cancel the current paste before pasting again.');
      return;
    }
    const element = findEditableElement(event);
    if (!element) return;
    // This MUST happen before any Promise, model initialization, UI work, or await.
    event.preventDefault();
    event.stopImmediatePropagation();
    let snapshot;
    try { snapshot = captureCursorState(event); } catch { /* Fail closed if a selection disappears. */ }
    snapshot ||= { element, kind: 'unsupported' };
    const operation = { snapshot, text, requestId: window.crypto.randomUUID(), timedOut: false };
    pending = operation;
    operation.dialog = openDialog(operation);
    if (snapshot.kind === 'unsupported') {
      operation.dialog.showError('PII Spy cannot safely restore the cursor in this field. Use a text field or text editor instead.', { allowOriginal: false });
      return;
    }
    operation.timeout = window.setTimeout(() => {
      operation.timedOut = true;
      showScanError(operation, 'The local PII scan took too long. No text was pasted. You can cancel or explicitly paste the original.');
    }, timeoutMs);
    void scan(operation);
  }

  function applyEnabled(value) {
    enabled = value !== false;
    if (!enabled && pending) finish(pending, true);
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.enabled) {
      settingsRevision += 1;
      applyEnabled(changes.enabled.newValue);
    }
  }

  window.addEventListener('paste', onPaste, true);
  chrome.storage?.onChanged?.addListener(onStorageChanged);
  // Default to protection while Chrome loads the saved setting.
  Promise.resolve(chrome.storage?.local?.get({ enabled: true }))
    .then((settings) => { if (!destroyed && settings && settingsRevision === 0) applyEnabled(settings.enabled); })
    .catch(() => {});

  return {
    destroy() {
      destroyed = true;
      if (pending) finish(pending, true);
      window.removeEventListener('paste', onPaste, true);
      chrome.storage?.onChanged?.removeListener(onStorageChanged);
    },
  };
}
