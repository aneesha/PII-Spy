const enabled = document.getElementById('enabled');
const detail = document.getElementById('protection-detail');
const status = document.getElementById('status');
const prepare = document.getElementById('prepare');
const error = document.getElementById('error');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function renderEnabled(value) {
  enabled.checked = value;
  detail.textContent = value
    ? 'On for new pastes. Keep sensitive details in your control.'
    : 'Protection is off. Pastes go directly to the website.';
}

async function updateStatus(type = 'GET_STATUS') {
  prepare.disabled = true;
  if (type === 'PREPARE_MODEL') {
    status.textContent = 'Preparing the local model. This can take a moment…';
    prepare.setAttribute('aria-busy', 'true');
  }
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type });
    if (!response?.ok) throw new Error(response?.error?.message || 'The detector did not respond.');
    const state = response.status?.state || 'idle';
    const messages = {
      idle: 'Loads locally on your first paste. Prepare it now to reduce the wait.',
      loading: 'Loading the local model… Your next paste will wait for the scan.',
      ready: 'Ready. All scans run locally on your device.',
      error: 'Detector unavailable. Run the model setup command in the README and reload the extension.',
    };
    status.textContent = messages[state] || messages.idle;
    prepare.textContent = state === 'ready' ? 'Check detector again' : 'Prepare detector';
  } catch (cause) {
    status.textContent = cause.message;
  } finally {
    prepare.disabled = false;
    prepare.removeAttribute('aria-busy');
  }
}

enabled.addEventListener('change', async () => {
  const value = enabled.checked;
  enabled.disabled = true;
  error.hidden = true;
  try {
    await chrome.storage.local.set({ enabled: value });
    renderEnabled(value);
  } catch {
    renderEnabled(!value);
    showError('Could not save the setting. Please try again.');
  } finally {
    enabled.disabled = false;
  }
});

prepare.addEventListener('click', () => updateStatus('PREPARE_MODEL'));
document.getElementById('test-editor').href = chrome.runtime.getURL('test-editor.html');

chrome.storage.local.get({ enabled: true }).then(({ enabled: value }) => {
  renderEnabled(value !== false);
  enabled.disabled = false;
}).catch(() => showError('Could not load protection settings. Reload the extension.'));
updateStatus();
