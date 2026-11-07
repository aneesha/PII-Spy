const status = document.getElementById('guard-status');

async function updateStatus() {
  try {
    const { enabled = true } = await chrome.storage.local.get({ enabled: true });
    status.textContent = enabled
      ? 'Protection is enabled. Your next paste will be scanned before insertion.'
      : 'Protection is paused. Enable PII Spy in the toolbar popup before testing.';
  } catch {
    status.textContent = 'Could not check protection status. Reload this extension page and try again.';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateStatus();
});

updateStatus();
