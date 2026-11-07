import { createBackgroundController } from './background-controller.js';

const controller = createBackgroundController(chrome);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return undefined;
  controller.handle(message, sender).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // Preserve the user's choice when updating the extension.
  chrome.storage.local.get({ enabled: true }).then(({ enabled }) => {
    chrome.storage.local.set({ enabled: enabled !== false });
  });
});
