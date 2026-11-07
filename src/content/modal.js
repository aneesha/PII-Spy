import { applyRedactions } from './redaction.js';

const layoutCss = `
:host{all:initial;color-scheme:light;font:16px system-ui,sans-serif}
dialog{display:block;width:min(620px,calc(100vw - 24px));min-width:0;height:fit-content;min-height:0;max-height:calc(100dvh - 24px);margin:auto;padding:0;border:0;border-radius:16px;overflow:auto;background:var(--pico-card-background-color);backdrop-filter:none;color-scheme:light;font:400 16px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(10,20,35,.6)}
dialog>article{width:100%;max-width:none;max-height:none;margin:0;padding:24px;box-shadow:none;border-radius:0}
h2{font-size:1.3rem;margin:0 0 8px}p{font-size:.95rem}.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.13em;color:var(--pico-primary);margin-bottom:12px}
.entity-list{max-height:200px;overflow:auto;margin:16px 0}.entity-list label{display:flex;width:100%;align-items:flex-start;gap:10px;border-bottom:1px solid var(--pico-muted-border-color);padding:10px 0;margin:0}
.entity-list input{flex-shrink:0;margin-top:5px}.entity-copy{min-width:0;overflow-wrap:anywhere}.entity-label{display:block;font-size:.75rem;color:var(--pico-muted-color);text-transform:uppercase}.entity-value{font-size:.9rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;padding:14px;font-size:.8rem;border:1px solid var(--pico-muted-border-color);border-radius:8px}
.actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin:20px 0 0}.actions button{width:auto;margin:0;padding:10px 14px;font-size:.85rem}
.privacy{font-size:.75rem;color:var(--pico-muted-color);margin:16px 0 0}.status{font-size:.8rem;color:var(--pico-muted-color);margin:8px 0 0}.preview-title{font-size:.8rem;font-weight:600;margin-bottom:6px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function node(document, tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

export function createGuardDialog({ document, css = '', originalText, onConfirm, onCancel }) {
  const host = document.createElement('div');
  host.id = 'pii-spy-guard';
  host.style.setProperty('all', 'initial', 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = node(document, 'style', css + layoutCss);
  const dialog = node(document, 'dialog', undefined, {
    'aria-labelledby': 'pii-spy-title', 'aria-describedby': 'pii-spy-description', 'data-theme': 'light',
  });
  const article = node(document, 'article');
  const eyebrow = node(document, 'p', 'PII SPY · LOCAL PASTE GUARD', { class: 'eyebrow' });
  const title = node(document, 'h2', 'Checking your paste…', { id: 'pii-spy-title', tabindex: '-1' });
  const description = node(document, 'p', 'Your text is held here while the local model checks it. The first scan may take longer.', { id: 'pii-spy-description' });
  const content = node(document, 'div');
  const status = node(document, 'p', '', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const actions = node(document, 'div', undefined, { class: 'actions' });
  const privacy = node(document, 'p', 'Clipboard text stays on this device. Only approved plain text is pasted.', { class: 'privacy' });
  article.append(eyebrow, title, description, content, status, actions, privacy);
  dialog.append(article);
  shadow.append(style, dialog);
  (document.documentElement || document).append(host);
  let closed = false;

  function button(label, action, callback, className) {
    const element = node(document, 'button', label, { type: 'button', 'data-action': action });
    if (className) element.className = className;
    element.addEventListener('click', callback);
    return element;
  }

  function cancelButton() {
    return button('Cancel', 'cancel', onCancel, 'secondary outline');
  }

  actions.append(cancelButton());
  dialog.setAttribute('aria-busy', 'true');
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    onCancel();
  });
  dialog.addEventListener('keydown', (event) => {
    // Native dialog supplies modality; keep focus cycling even in fallback/test environments.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled])')];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (shadow.activeElement === first || shadow.activeElement === title)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    event.stopPropagation();
  });
  // Clipboard shortcuts inside the guard must not bubble into page editor handlers.
  dialog.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  actions.firstElementChild?.focus();

  return {
    host,
    close() {
      if (closed) return;
      closed = true;
      if (typeof dialog.close === 'function') dialog.close();
      host.remove();
    },
    setStatus(message) { status.textContent = message; },
    showReview(entities) {
      dialog.removeAttribute('aria-busy');
      title.textContent = 'Personal information detected';
      description.textContent = 'Select the items to redact. Review the result before pasting.';
      content.replaceChildren();
      status.textContent = '';
      const list = node(document, 'div', undefined, { class: 'entity-list' });
      const checkboxes = [];
      const preview = node(document, 'pre', '', { 'data-preview': '', tabindex: '0', 'aria-label': 'Text that will be pasted' });
      const selected = () => entities.filter((_, index) => checkboxes[index].checked);
      const update = () => { preview.textContent = applyRedactions(originalText, selected()); };
      entities.forEach((entity, index) => {
        const label = node(document, 'label');
        const checkbox = node(document, 'input', undefined, { type: 'checkbox', 'data-entity-index': String(index) });
        checkbox.checked = true;
        checkbox.addEventListener('change', update);
        checkboxes.push(checkbox);
        const copy = node(document, 'span', undefined, { class: 'entity-copy' });
        copy.append(node(document, 'span', entity.label, { class: 'entity-label' }),
          node(document, 'span', originalText.slice(entity.start, entity.end), { class: 'entity-value' }));
        label.append(checkbox, copy);
        list.append(label);
      });
      update();
      content.append(list, node(document, 'p', 'Paste preview', { class: 'preview-title' }), preview);
      actions.replaceChildren(cancelButton(),
        button('Paste Original', 'original', () => onConfirm(originalText), 'secondary outline'),
        button('Redact & Paste', 'redact', () => onConfirm(applyRedactions(originalText, selected()))));
      actions.lastElementChild.focus();
    },
    showError(message, { allowOriginal = true } = {}) {
      dialog.removeAttribute('aria-busy');
      title.textContent = allowOriginal ? 'Your paste could not be checked' : 'Paste paused';
      description.textContent = message;
      content.replaceChildren();
      status.textContent = allowOriginal ? 'No text has been pasted. Pasting the original skips the PII check.' : '';
      actions.replaceChildren(cancelButton());
      if (allowOriginal) actions.append(button('Paste Original', 'original', () => onConfirm(originalText), 'secondary outline'));
      actions.firstElementChild.focus();
    },
  };
}
