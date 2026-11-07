import { createScanner } from './scanner.js';
import { loadModel } from './model.js';

const scanner = createScanner(loadModel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return false;
  if (message.type === 'GET_STATUS') {
    sendResponse({ ok: true, status: scanner.getStatus() });
    return false;
  }
  if (message.type !== 'SCAN_PII' && message.type !== 'PREPARE_MODEL') return false;
  Promise.resolve().then(async () => {
    if (message.type === 'PREPARE_MODEL') {
      await scanner.prepare();
      return { ok: true, status: scanner.getStatus() };
    }
    const entities = await scanner.scan(message.text);
    return { ok: true, entities, requestId: message.requestId };
  }).then(sendResponse).catch(() => {
    // Never expose library errors (which could contain the clipboard payload).
    sendResponse({ ok: false, error: { code: 'SCAN_FAILED', message: 'The local detector could not complete this scan. Nothing was pasted. Try preparing the detector in the extension popup.' }, requestId: message.requestId });
  });
  return true;
});
