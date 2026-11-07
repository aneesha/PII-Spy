const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

function isDisabled(element) {
  return element.disabled || element.readOnly || element.matches?.(':disabled') || element.closest?.('[inert]');
}

function parentElement(element) {
  return element.parentElement || element.getRootNode?.().host || null;
}

export function findEditableElement(event) {
  const path = event.composedPath?.() || [event.target];
  let element = path.find((node) => node?.nodeType === 1);
  let editable = null;
  while (element) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      if (isDisabled(element)) return null;
      // Buttons, checkboxes and other nontext controls are never paste destinations.
      if (tag === 'INPUT' && !TEXT_INPUT_TYPES.has(element.type)
        && !['email', 'number'].includes(element.type)) return null;
      return element;
    }
    const mode = element.getAttribute?.('contenteditable')?.toLowerCase();
    if (mode === 'false') break;
    if (mode === '' || mode === 'true' || mode === 'plaintext-only') editable = element;
    element = parentElement(element);
  }
  return editable;
}

function getSelection(element) {
  const root = element.getRootNode?.();
  return root?.getSelection?.() || element.ownerDocument.getSelection();
}

export function captureCursorState(event) {
  const element = findEditableElement(event);
  if (!element) return null;
  const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
  if (isInput) {
    if (!Number.isInteger(element.selectionStart) || !Number.isInteger(element.selectionEnd)) {
      return { element, kind: 'unsupported' };
    }
    return {
      element, kind: 'input', original: element.value,
      selectionStart: element.selectionStart, selectionEnd: element.selectionEnd,
      selectionDirection: element.selectionDirection,
    };
  }
  const selection = getSelection(element);
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return { element, kind: 'unsupported' };
  }
  return {
    element, kind: 'editable', original: element.innerHTML, range,
    // DOM Ranges are live: an otherwise identical framework rerender can move
    // their endpoints. Keep immutable endpoints to detect that change.
    startContainer: range.startContainer, startOffset: range.startOffset,
    endContainer: range.endContainer, endOffset: range.endOffset,
  };
}

export function isSnapshotValid(snapshot) {
  const { element, kind } = snapshot;
  if (!element?.isConnected || isDisabled(element) || kind === 'unsupported') return false;
  if (findEditableElement({ target: element }) !== element) return false;
  if (kind === 'input') return element.value === snapshot.original
    && Number.isInteger(element.selectionStart) && Number.isInteger(element.selectionEnd);
  return element.innerHTML === snapshot.original
    && element.contains(snapshot.startContainer) && element.contains(snapshot.endContainer)
    && snapshot.range.startContainer === snapshot.startContainer && snapshot.range.startOffset === snapshot.startOffset
    && snapshot.range.endContainer === snapshot.endContainer && snapshot.range.endOffset === snapshot.endOffset;
}

export function restoreFocusOnly(snapshot) {
  if (!snapshot?.element?.isConnected) return false;
  const { element } = snapshot;
  try {
    element.focus({ preventScroll: true });
    if (!isSnapshotValid(snapshot)) return false;
    if (snapshot.kind === 'input') {
      element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection);
    } else {
      const selection = getSelection(element);
      selection.removeAllRanges();
      selection.addRange(snapshot.range);
    }
    return (element.getRootNode().activeElement || element.ownerDocument.activeElement) === element;
  } catch {
    // Page navigation or a framework rerender can remove a saved selection.
    return false;
  }
}

function inputEvent(element, type, text, cancelable) {
  const view = element.ownerDocument.defaultView;
  return new view.InputEvent(type, {
    bubbles: true, composed: true, cancelable, inputType: 'insertFromPaste', data: text,
  });
}

export function insertTextAtSnapshot(snapshot, text) {
  if (!isSnapshotValid(snapshot)) {
    return { ok: false, message: 'The destination changed while scanning. Nothing was pasted. Cancel and paste again.' };
  }
  const { element } = snapshot;
  const document = element.ownerDocument;
  // Focusing can synchronously invoke host handlers that rerender or redirect
  // focus. Never let execCommand insert into whatever field those handlers pick.
  if (!restoreFocusOnly(snapshot) || !isSnapshotValid(snapshot)) {
    return { ok: false, message: 'The destination changed while restoring focus. Cancel and paste again.' };
  }
  try {
    // insertText retains the browser undo stack and lets editor frameworks observe the edit.
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
      return { ok: true };
    }
    // A command may mutate before reporting failure. Never insert the payload twice.
    if (!isSnapshotValid(snapshot)) return { ok: true };
    if (!element.dispatchEvent(inputEvent(element, 'beforeinput', text, true))) {
      return { ok: false, message: 'This editor declined the paste. Nothing further was inserted.' };
    }
    if (!isSnapshotValid(snapshot)) return { ok: true };
    if (snapshot.kind === 'input') {
      let replacement = text;
      if (element.maxLength >= 0) {
        const available = element.maxLength - (snapshot.original.length - (snapshot.selectionEnd - snapshot.selectionStart));
        replacement = replacement.slice(0, Math.max(0, available));
      }
      const next = snapshot.original.slice(0, snapshot.selectionStart) + replacement
        + snapshot.original.slice(snapshot.selectionEnd);
      const prototype = element.tagName === 'TEXTAREA'
        ? document.defaultView.HTMLTextAreaElement.prototype : document.defaultView.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, next);
      const caret = Math.min(snapshot.selectionStart + replacement.length, element.value.length);
      element.setSelectionRange(caret, caret);
    } else {
      const range = snapshot.range;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      const selection = getSelection(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    // Dispatching an untrusted ClipboardEvent has no browser default insertion action.
    // Mutate explicitly, then notify editors, and never carry clipboard text/html.
    element.dispatchEvent(inputEvent(element, 'input', text, false));
    return { ok: true };
  } catch {
    return { ok: false, message: 'PII Spy could not paste into this editor. Cancel and try again.' };
  }
}
