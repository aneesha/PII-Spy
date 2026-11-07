export const MAX_TEXT_LENGTH = 50_000;
const SCAN_TIMEOUT_MS = 120_000;

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

// No clipboard content is stored here: only settings live in chrome.storage.
export function createBackgroundController(api, { timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  let creatingOffscreen;
  const extensionOrigin = api.runtime.getURL('');
  const offscreenUrl = api.runtime.getURL('offscreen.html');

  function isExtensionPage(sender) {
    return sender.id === api.runtime.id &&
      [api.runtime.getURL('popup.html'), api.runtime.getURL('test-editor.html')].includes(sender.url);
  }

  function canScan(sender) {
    if (sender.id !== api.runtime.id) return false;
    if (sender.url === api.runtime.getURL('test-editor.html')) return true;
    if (!sender.tab || !sender.url) return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === 'https:' && ['chatgpt.com', 'claude.ai'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async function ensureOffscreen() {
    if (creatingOffscreen) return creatingOffscreen;
    // Assign before the first await, including getContexts, so concurrent tabs share one creation.
    creatingOffscreen = (async () => {
      const contexts = await api.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl],
      });
      if (!contexts.length) {
        await api.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS', 'BLOBS'],
          justification: 'Run the bundled local PII model in an isolated document across tabs.',
        });
      }
    })();
    try {
      await creatingOffscreen;
    } finally {
      creatingOffscreen = undefined;
    }
  }

  async function withTimeout(operation) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The local detector took too long. Please retry.')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function route(type, extra = {}) {
    return withTimeout((async () => {
      await ensureOffscreen();
      const result = await api.runtime.sendMessage({ target: 'offscreen', type, ...extra });
      if (!result || typeof result.ok !== 'boolean') {
        return failure('INVALID_RESPONSE', 'The local detector did not respond. Reload the extension and try again.');
      }
      if (result.ok && type === 'SCAN_PII' && !Array.isArray(result.entities)) {
        return failure('INVALID_RESPONSE', 'The local detector returned an invalid scan.');
      }
      return result;
    })());
  }

  async function handle(message, sender) {
    if (sender.id !== api.runtime.id || !sender.url?.startsWith(extensionOrigin) && !canScan(sender)) {
      return failure('UNAUTHORIZED', 'This page cannot use the detector.');
    }
    try {
      if (message.type === 'SCAN_PII') {
        if (!canScan(sender)) return failure('UNAUTHORIZED', 'This page is not protected by PII Spy.');
        if (typeof message.text !== 'string' || message.text.length > MAX_TEXT_LENGTH || !message.text.length) {
          return failure('INVALID_TEXT', `Paste between 1 and ${MAX_TEXT_LENGTH.toLocaleString('en-US')} characters at a time.`);
        }
        return await route('SCAN_PII', { requestId: message.requestId, text: message.text });
      }
      if (!isExtensionPage(sender)) return failure('UNAUTHORIZED', 'Only PII Spy can manage the detector.');
      if (message.type === 'GET_STATUS') return await route('GET_STATUS');
      if (message.type === 'PREPARE_MODEL') return await route('PREPARE_MODEL');
      return failure('UNKNOWN_MESSAGE', 'Unknown PII Spy request.');
    } catch {
      // Runtime exception messages may contain model inputs. Keep errors generic.
      return failure('DETECTOR_UNAVAILABLE', 'The local detector is unavailable. Check the model setup in the README, then retry.');
    }
  }

  return { ensureOffscreen, handle };
}
