const statusEl = document.getElementById('status');

const LABELS = { pp: 'Power Platform API', flow: 'Flow API' };

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (res) => {
    if (chrome.runtime.lastError || !res || res.error) {
      statusEl.textContent = 'Status unavailable.';
      statusEl.className = 'warn';
      return;
    }
    const live = Object.entries(res.tokens).filter(([, t]) => t);
    if (!live.length) {
      statusEl.textContent = 'Not signed in. Open or reload make.powerautomate.com or make.powerapps.com in this browser.';
      statusEl.className = 'warn';
      return;
    }
    statusEl.textContent = 'Signed in: ' + live.map(([name, t]) => LABELS[name] + ' (' + t.expiresInMin + ' min left)').join(', ') + '.';
    statusEl.className = 'ok';
  });
}

document.getElementById('forget').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'forgetToken' }, refresh);
});

refresh();
