// WA Campaign Scheduler – runs inside web.whatsapp.com
// Asks the background worker whether a message is waiting for this tab, then sends it
// exactly like a person would: open chat -> (attach image) -> type -> press send.
(() => {
  if (window.top !== window) return;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (a, b) => sleep(a + Math.random() * (b - a));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const visible = (el) => !!el && el.isConnected && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);

  const wlog = (msg, level = 'info') => chrome.runtime.sendMessage({ type: 'WA_LOG', payload: { msg, level } }).catch(() => {});

  async function waitFor(fn, timeout = 30000, every = 400) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(every);
    }
    return null;
  }

  // ---------- locators (prefer language‑independent hooks: data-icon, structure) ----------
  const isLoggedIn = () => !!($('#side') || $('#pane-side') || $('[data-testid="chat-list"]'));
  const composeBox = () => {
    const c = $$('#main footer div[contenteditable="true"]').filter(visible);
    if (c.length) return c[c.length - 1];
    return $$('footer div[contenteditable="true"]').filter(visible).pop() || null;
  };
  const clickable = (el) => el && (el.closest('button,[role="button"]') || el);

  function footerSendButton() {
    const foot = $('#main footer') || document;
    const icon = $$('[data-icon="send"],[data-icon="wds-ic-send-filled"],[data-icon*="send"]', foot).filter(visible)[0];
    if (icon) return clickable(icon);
    return $$('button[aria-label="Send"],[role="button"][aria-label="Send"]', foot).filter(visible)[0] || null;
  }

  function mediaSendButton() {
    const footer = $('#main footer');
    const icons = $$('[data-icon="send"],[data-icon="wds-ic-send-filled"],[data-icon*="send"]').filter(el => visible(el) && !(footer && footer.contains(el)));
    if (icons.length) return clickable(icons[icons.length - 1]);
    const btn = $$('[aria-label="Send"]').filter(el => visible(el) && !(footer && footer.contains(el)));
    return btn.pop() || null;
  }

  function captionBox() {
    const footer = $('#main footer');
    const side = $('#side');
    const eds = $$('div[contenteditable="true"]').filter(el => visible(el) && !(footer && footer.contains(el)) && !(side && side.contains(el)));
    return eds.pop() || null;
  }

  function invalidPopup() {
    const dlg = $$('[data-animate-modal-popup="true"], div[role="dialog"]').filter(visible);
    for (const d of dlg) {
      const t = (d.innerText || '').toLowerCase();
      if (/invalid|not on whatsapp|isn.t on whatsapp|अमान्य|व्हाट्सएप पर नहीं|no está en whatsapp|inválido/.test(t)) return d;
    }
    return null;
  }

  function anyBlockingDialog() {
    return $$('[data-animate-modal-popup="true"], div[role="dialog"]').filter(visible)[0] || null;
  }

  // ---------- input helpers ----------
  function pasteText(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  async function typeInto(el, text) {
    el.focus();
    await sleep(200);
    pasteText(el, text);
    await sleep(500);
    const probe = text.trim().slice(0, 12);
    if (probe && !(el.innerText || '').includes(probe)) {
      // fallback: insert line by line, Shift+Enter between lines
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
        if (i < lines.length - 1) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true }));
        }
        await sleep(40);
      }
      await sleep(300);
    }
    return (el.innerText || '').includes(probe);
  }

  function pressEnter(el) {
    el.focus();
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  async function dataUrlToFile(dataUrl, name) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return new File([blob], (name && /\.\w+$/.test(name) ? name : 'image.' + ext), { type: blob.type || 'image/jpeg' });
  }

  async function waitOutgoingDelivered() {
    // wait for the pending "clock" icon of the last outgoing message to go away
    await sleep(1500);
    await waitFor(() => !$$('#main [data-icon="msg-time"]').filter(visible).length, 20000, 500);
  }

  // ---------- attach image ----------
  async function attachImage(file) {
    const box = composeBox();
    // Way 1: paste the image into the chat box (opens WhatsApp's media editor)
    if (box) {
      box.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (await waitFor(mediaSendButton, 8000)) return true;
    }
    // Way 2: attach menu -> hidden file input
    const attachIcon = $$('#main footer [data-icon="plus"],#main footer [data-icon="plus-rounded"],#main footer [data-icon="attach-menu-plus"],#main footer [data-icon="clip"],#main [aria-label="Attach"],#main [title="Attach"]').filter(visible)[0];
    if (attachIcon) { clickable(attachIcon).click(); await sleep(900); }
    const inputs = $$('input[type="file"]');
    const input = inputs.find(i => /image/.test(i.accept || '')) || inputs[0];
    if (!input) return false;
    const dt2 = new DataTransfer();
    dt2.items.add(file);
    input.files = dt2.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!(await waitFor(mediaSendButton, 12000));
  }

  // ---------- main flow ----------
  async function sendJob(job) {
    wlog(`Chat page loaded for ${job.phone}, waiting for WhatsApp…`);
    const state = await waitFor(() => {
      if (invalidPopup()) return 'invalid';
      if (composeBox()) return 'ready';
      return null;
    }, 70000, 500);

    if (!state) {
      if (!isLoggedIn()) return { ok: false, error: 'NOT_LOGGED_IN' };
      if (anyBlockingDialog()) return { ok: false, error: 'INVALID_NUMBER (popup shown)' };
      return { ok: false, error: 'CHAT_DID_NOT_OPEN' };
    }
    if (state === 'invalid') {
      const okBtn = $$('button', invalidPopup()).pop(); if (okBtn) okBtn.click();
      return { ok: false, error: 'INVALID_NUMBER / NOT_ON_WHATSAPP' };
    }

    await jitter(1500, 3500); // human-like pause

    if (job.image) {
      const file = await dataUrlToFile(job.image, job.imageName);
      const attached = await attachImage(file);
      if (!attached) return { ok: false, error: 'IMAGE_ATTACH_FAILED' };
      await jitter(800, 1800);
      if (job.text) {
        const cap = await waitFor(captionBox, 6000);
        if (cap) await typeInto(cap, job.text);
        else wlog('Caption box not found – sending image without caption', 'warn');
      }
      await jitter(700, 1500);
      const btn = mediaSendButton();
      if (!btn) return { ok: false, error: 'MEDIA_SEND_BUTTON_NOT_FOUND' };
      btn.click();
      const closed = await waitFor(() => !mediaSendButton(), 20000, 500);
      if (!closed) return { ok: false, error: 'MEDIA_EDITOR_DID_NOT_CLOSE' };
      await waitOutgoingDelivered();
      return { ok: true };
    }

    // text only – text is pre-filled from the URL; fill it ourselves if not
    const box = composeBox();
    const probe = (job.text || '').trim().slice(0, 12);
    const filled = await waitFor(() => (box.innerText || '').trim().length > 0, 6000);
    if (!filled && job.text) await typeInto(box, job.text);
    if (probe && !(composeBox().innerText || '').includes(probe)) {
      return { ok: false, error: 'TEXT_NOT_FILLED' };
    }
    await jitter(600, 1400);
    const sendBtn = await waitFor(footerSendButton, 5000);
    if (sendBtn) sendBtn.click(); else pressEnter(composeBox());
    const emptied = await waitFor(() => { const b = composeBox(); return b && !(b.innerText || '').trim(); }, 8000);
    if (!emptied) return { ok: false, error: 'SEND_BUTTON_NOT_FOUND' };
    await waitOutgoingDelivered();
    return { ok: true };
  }

  async function main() {
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'WA_READY', payload: { url: location.href } }); }
    catch { return; }
    const job = res && res.job;
    if (!job) return;
    let out;
    try { out = await sendJob(job); }
    catch (e) { out = { ok: false, error: 'SCRIPT_ERROR ' + (e && e.message || e) }; }
    chrome.runtime.sendMessage({ type: 'WA_RESULT', payload: { jobId: job.id, ok: out.ok, error: out.error || '' } }).catch(() => {});
  }

  main();
})();
