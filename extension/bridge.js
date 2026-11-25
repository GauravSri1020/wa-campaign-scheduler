// Relays messages between the dashboard page and the extension background.
(() => {
  const TAG = '__wasched';
  const VERSION = chrome.runtime.getManifest().version;

  function hello() {
    window.postMessage({ [TAG]: 'hello', version: VERSION }, '*');
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== 'req') return;
    const { id, type, payload } = ev.data;
    if (type === 'PING') { hello(); return; }
    try {
      const res = await chrome.runtime.sendMessage({ type, payload });
      window.postMessage({ [TAG]: 'res', id, ok: !res || res.ok !== false, data: res }, '*');
    } catch (e) {
      window.postMessage({ [TAG]: 'res', id, ok: false, data: { ok: false, error: String(e && e.message || e) } }, '*');
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STATUS_PUSH') {
      window.postMessage({ [TAG]: 'status', data: msg.data }, '*');
    }
  });

  hello();
  document.addEventListener('DOMContentLoaded', hello);
})();
