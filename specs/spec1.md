# Technical Specification: GLiNER Pre-Paste PII Guard (Manifest V3)

## 1. Overview & Problem Statement
This specification defines the architecture and implementation details for a Manifest V3 Chrome Extension that intercepts user paste actions (`Ctrl+V` / `Cmd+V` / context-menu Paste) on designated target websites, scans the clipboard payload for Personally Identifiable Information (PII) locally in the browser using [`gliner`](https://socket.dev/npm/package/gliner), and presents an interactive redaction modal before any data reaches the host web application.

### Core Technical Constraint
Browser DOM `paste` event handlers are **synchronous**, whereas ONNX Runtime Web inference (`gliner`) is **asynchronous**. Calling `await` inside a `paste` event listener before invoking `event.preventDefault()` allows the event to finish bubbling, causing the browser to paste the unredacted text before model inference completes.

### Architectural Solution
The extension **unconditionally blocks the native paste event synchronously during the capture phase**, snapshots the active DOM element and cursor/selection range, delegates inference asynchronously to an isolated Offscreen Document running `gliner`, and then **synthetically injects** the approved or redacted payload back into the saved cursor position.

---

## 2. System Architecture

Running ONNX Runtime Web directly inside a Content Script fails on many modern sites (e.g., ChatGPT, Claude, enterprise apps) due to strict host Content Security Policies (CSP) blocking `wasm-unsafe-eval`, and forces redundant downloads of the ~80–200MB ONNX model per tab.

To avoid this, the extension is divided into three layers:

1. **Content Script (`content.js` - Capture, UI & Injection):**
   * Runs only on matched target URLs at `document_start`.
   * Intercepts the `paste` event in the capture phase (`useCapture = true`), halts propagation immediately, and caches the active DOM element and cursor/selection range.
   * Renders an isolated Shadow DOM modal if PII is detected, allowing the user to selectively **Redact & Paste**, **Paste Original**, or **Cancel**.
2. **Background Service Worker (`background.js` - Lifecycle & Routing):**
   * Manages the lifecycle of the Offscreen Document so the ONNX session stays warm across tabs.
   * Routes scan requests between the Content Script and Offscreen Document.
3. **Offscreen Document (`offscreen.html` / `offscreen.js` - GLiNER Inference Engine):**
   * Hosts the singleton [`gliner`](https://socket.dev/npm/package/gliner) instance using WebAssembly (`wasm-unsafe-eval` permitted in extension pages) or WebGPU.
   * Executes zero-shot NER PII detection against quantized ONNX weights (e.g., `knowledgator/gliner-pii-small-v1.0` or `onnx-community/gliner_small-v2.1`).

---

## 3. Dependencies & References

* **GLiNER JavaScript Package:** [`gliner` on Socket.dev](https://socket.dev/npm/package/gliner)
* **ONNX Runtime Web:** `onnxruntime-web` (bundled alongside `gliner` for WASM/WebGPU execution)
* **Recommended Quantized ONNX Model:** `knowledgator/gliner-pii-small-v1.0` (INT8 quantized `.onnx` + `tokenizer.json`)

---

## 4. Component Implementation Specifications

### 4.1 Manifest Configuration (`manifest.json`)
Configures target host permissions, registers the `offscreen` permission, and enables `wasm-unsafe-eval` inside extension pages for ONNX Runtime Web.

```json
{
  "manifest_version": 3,
  "name": "GLiNER Pre-Paste PII Guard",
  "version": "1.0.0",
  "description": "Intercepts paste events on specific sites to detect and redact PII locally using gliner.js before pasting.",
  "permissions": [
    "offscreen",
    "storage"
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": [
        "https://chatgpt.com/*",
        "https://claude.ai/*",
        "https://*.your-target-site.com/*"
      ],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["models/*", "wasm/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

---

### 4.2 Background Service Worker (`background.js`)
Ensures the Offscreen Document is created once and forwards `SCAN_PII` messages from the Content Script to the Offscreen Document.

```javascript
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreen;

async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Run GLiNER ONNX Runtime Web inference in an isolated context'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_PII') {
    (async () => {
      await setupOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_SCAN_PII',
        text: message.text
      });
      sendResponse(response);
    })();
    return true; // Keep message channel open for async response
  }
});
```

---

### 4.3 Offscreen Inference Engine (`offscreen.js`)
Initializes [`gliner`](https://socket.dev/npm/package/gliner) and maintains the loaded ONNX session in memory.

```javascript
import { Gliner } from 'gliner';

let glinerInstance = null;

const PII_LABELS = [
  "person",
  "email",
  "phone number",
  "credit card",
  "ssn",
  "ip address",
  "physical address",
  "api key",
  "date of birth"
];

async function getGliner() {
  if (!glinerInstance) {
    glinerInstance = new Gliner({
      tokenizerPath: "knowledgator/gliner-pii-small-v1.0",
      onnxSettings: {
        modelPath: chrome.runtime.getURL("models/gliner_pii_small_quantized.onnx"),
        executionProvider: "wasm", // Or "webgpu" where supported
        wasmPaths: chrome.runtime.getURL("wasm/")
      }
    });
    await glinerInstance.initialize();
  }
  return glinerInstance;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_SCAN_PII') {
    (async () => {
      try {
        const model = await getGliner();
        const results = await model.inference({
          texts: [msg.text],
          entities: PII_LABELS,
          flatNer: true,
          threshold: 0.45
        });
        // results[0] contains [{ spanText, label, start, end, score }, ...]
        sendResponse({ entities: results[0] || [] });
      } catch (error) {
        console.error('GLiNER inference error:', error);
        sendResponse({ entities: [], error: error.message });
      }
    })();
    return true;
  }
});
```

---

### 4.4 Content Script: Synchronous Interception & Synthetic Paste (`content.js`)

#### Part A: Capture-Phase Paste Interception
Listening on `window` with `useCapture = true` intercepts `Ctrl+V` before React, ProseMirror, Lexical, or Monaco editors on the host page can process the event.

```javascript
let isSyntheticPaste = false;

window.addEventListener('paste', async (event) => {
  if (isSyntheticPaste) return;

  const pastedText = event.clipboardData?.getData('text/plain');
  if (!pastedText || !pastedText.trim()) return;

  // 1. CRITICAL: Synchronously halt the native paste immediately
  event.preventDefault();
  event.stopImmediatePropagation();

  // 2. Snapshot the exact target element and cursor/selection state
  const targetSnapshot = captureCursorState(event.target);

  // 3. Request asynchronous PII scan from GLiNER worker
  const response = await chrome.runtime.sendMessage({
    type: 'SCAN_PII',
    text: pastedText
  });

  // 4. Branch based on detection results
  if (!response?.entities || response.entities.length === 0) {
    insertTextAtSnapshot(targetSnapshot, pastedText);
  } else {
    showPiiModal({
      originalText: pastedText,
      entities: response.entities,
      onConfirm: (finalText) => insertTextAtSnapshot(targetSnapshot, finalText),
      onCancel: () => restoreFocusOnly(targetSnapshot)
    });
  }
}, true); // <-- true enables Capture Phase
```

#### Part B: Cursor State Snapshot & Cross-Framework Text Injection
Handles both standard `<input>`/`<textarea>` elements and rich-text `contenteditable` editors (ProseMirror, Slate, Lexical) using `document.execCommand('insertText')` with native value setter and `ClipboardEvent` fallbacks.

```javascript
function captureCursorState(targetElement) {
  const activeEl = document.activeElement || targetElement;
  const isInput = activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT';

  let selectionRange = null;
  if (!isInput) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      selectionRange = sel.getRangeAt(0).cloneRange();
    }
  }

  return {
    element: activeEl,
    isInput,
    selectionStart: isInput ? activeEl.selectionStart : null,
    selectionEnd: isInput ? activeEl.selectionEnd : null,
    selectionRange
  };
}

function restoreFocusOnly(snapshot) {
  const { element, isInput, selectionStart, selectionEnd, selectionRange } = snapshot;
  element.focus();
  if (isInput && selectionStart !== null) {
    element.setSelectionRange(selectionStart, selectionEnd);
  } else if (selectionRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(selectionRange);
  }
}

function insertTextAtSnapshot(snapshot, textToPaste) {
  const { element, isInput, selectionStart, selectionEnd, selectionRange } = snapshot;
  element.focus();

  if (isInput) {
    element.setSelectionRange(selectionStart, selectionEnd);
    if (!document.execCommand('insertText', false, textToPaste)) {
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

      const currentVal = element.value;
      const newVal = currentVal.slice(0, selectionStart) + textToPaste + currentVal.slice(selectionEnd);
      nativeInputValueSetter?.call(element, newVal);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  if (selectionRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(selectionRange);
  }

  const success = document.execCommand('insertText', false, textToPaste);

  if (!success) {
    isSyntheticPaste = true;
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', textToPaste);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(pasteEvent);
    isSyntheticPaste = false;
  }
}
```

#### Part C: Reverse-Offset Redaction & Shadow DOM Pop-up Modal
Replacing substrings in reverse order by `start` index prevents character offset shifts during redaction. Rendering inside a closed `ShadowRoot` isolates styles from the host page.

```javascript
function applyRedactions(originalText, selectedEntities) {
  // Sort descending by start offset so earlier replacements don't shift later indices
  const sorted = [...selectedEntities].sort((a, b) => b.start - a.start);

  let redacted = originalText;
  for (const entity of sorted) {
    const tag = `[${entity.label.toUpperCase().replace(/\s+/g, '_')}]`;
    redacted = redacted.slice(0, entity.start) + tag + redacted.slice(entity.end);
  }
  return redacted;
}

function showPiiModal({ originalText, entities, onConfirm, onCancel }) {
  const host = document.createElement('div');
  host.id = 'gliner-pii-guard-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  const container = document.createElement('div');
  container.innerHTML = `
    <style>
      .backdrop {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647; font-family: system-ui, -apple-system, sans-serif;
      }
      .modal {
        background: #ffffff; color: #111827; width: 440px; max-width: 92vw;
        border-radius: 10px; padding: 20px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2);
      }
      h3 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
      p { margin: 0 0 12px; font-size: 13px; color: #4b5563; }
      .entity-list {
        max-height: 200px; overflow-y: auto; border: 1px solid #e5e7eb;
        border-radius: 6px; padding: 8px; margin-bottom: 16px;
      }
      .entity-item {
        display: flex; align-items: center; gap: 8px; padding: 6px 4px;
        font-size: 13px; border-bottom: 1px solid #f3f4f6;
      }
      .entity-item:last-child { border-bottom: none; }
      .badge {
        background: #fee2e2; color: #991b1b; padding: 2px 6px;
        border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
      }
      .actions { display: flex; justify-content: flex-end; gap: 8px; }
      button {
        padding: 8px 12px; border-radius: 6px; font-size: 13px;
        font-weight: 500; cursor: pointer; border: 1px solid transparent;
      }
      .btn-cancel { background: #f3f4f6; color: #374151; }
      .btn-raw { background: #ffffff; border-color: #d1d5db; color: #374151; }
      .btn-redact { background: #2563eb; color: #ffffff; }
    </style>
    <div class="backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>PII Detected Before Paste</h3>
        <p>Select the items you want to redact before pasting:</p>
        <div class="entity-list">
          ${entities.map((e, idx) => `
            <label class="entity-item">
              <input type="checkbox" data-idx="${idx}" checked />
              <span class="badge">${e.label}</span>
              <span>${e.spanText}</span>
            </label>
          `).join('')}
        </div>
        <div class="actions">
          <button class="btn-cancel" id="pii-cancel">Cancel</button>
          <button class="btn-raw" id="pii-paste-raw">Paste Unredacted</button>
          <button class="btn-redact" id="pii-paste-redact">Redact & Paste</button>
        </div>
      </div>
    </div>
  `;

  shadow.appendChild(container);
  document.documentElement.appendChild(host);

  const cleanup = () => host.remove();

  shadow.getElementById('pii-cancel').addEventListener('click', () => {
    cleanup();
    onCancel();
  });

  shadow.getElementById('pii-paste-raw').addEventListener('click', () => {
    cleanup();
    onConfirm(originalText);
  });

  shadow.getElementById('pii-paste-redact').addEventListener('click', () => {
    const checkedIndices = Array.from(shadow.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => Number(cb.getAttribute('data-idx')));
    const selectedEntities = checkedIndices.map(i => entities[i]);
    const redactedText = applyRedactions(originalText, selectedEntities);
    cleanup();
    onConfirm(redactedText);
  });
}
```

---

## 5. Performance & Security Considerations

1. **Latency Optimization:**
   * Running quantized `gliner-pii-small` (~83MB) on CPU (`wasm`) takes ~80–250ms per paragraph. Enable `executionProvider: "webgpu"` when `navigator.gpu` is available for sub-40ms inference.
   * Combine GLiNER with a synchronous pre-pass regex filter for high-certainty structured tokens (IPv4, SSNs, standard emails, API keys) to highlight obvious patterns immediately.
2. **Rich-Text Clipboard Stripping:**
   * When redacting PII, only `text/plain` is synthetically injected so that hidden unredacted PII inside `text/html` clipboard payloads cannot leak into the target editor.