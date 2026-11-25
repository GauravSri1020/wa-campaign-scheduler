// WA Campaign Scheduler – background service worker
// State lives in chrome.storage.local so it survives the worker sleeping and browser restarts.
//
// storage keys:
//   campaign: { id, name, settings, jobs: [...] }
//   images:   { [key]: dataURL }
//   run:      { running, current, nextAllowedAt, daily: {YYYY-MM-DD: n}, pausedReason }
//   logs:     [ {t, level, msg} ]
//   optout:   [ phone, ... ]

const TICK = 'wa-tick';
const SEND_TIMEOUT_MS = 3 * 60 * 1000;
const HARD_DAILY_CAP = 60; // safety ceiling, regardless of settings

// ---------- storage helpers ----------
async function get(keys) { return chrome.storage.local.get(keys); }
async function set(obj) { return chrome.storage.local.set(obj); }

async function log(level, msg) {
  const { logs = [] } = await get('logs');
  logs.push({ t: Date.now(), level, msg });
  while (logs.length > 300) logs.shift();
  await set({ logs });
}

function dayKey(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  } catch { return new Date(ts).toISOString().slice(0, 10); }
}

function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const parts = Object.fromEntries(f.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { minutes: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10), weekday: wd };
}

function hm(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); }

function rand(a, b) { return a + Math.random() * (b - a); }

// ---------- status ----------
async function status(includeJobs = true) {
  const { campaign, run = {}, logs = [] } = await get(['campaign', 'run', 'logs']);
  const jobs = campaign ? campaign.jobs : [];
  const counts = { total: jobs.length, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const tz = campaign && campaign.settings && campaign.settings.tz;
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    campaign: campaign ? { id: campaign.id, name: campaign.name, settings: campaign.settings } : null,
    counts,
    run: { running: !!run.running, current: run.current || null, nextAllowedAt: run.nextAllowedAt || 0, sentToday: (run.daily || {})[dayKey(Date.now(), tz)] || 0, pausedReason: run.pausedReason || '' },
    jobs: includeJobs ? jobs.map(({ id, phone, name, text, image, at, status, error, sentAt, attempts, test }) => ({ id, phone, name, text: text ? text.slice(0, 140) : '', image, at, status, error, sentAt, attempts, test })) : undefined,
    logs: logs.slice(-80)
  };
}

async function pushStatus() {
  const s = await status(false);
  const tabs = await chrome.tabs.query({ url: ['https://*.github.io/*', 'http://localhost/*', 'http://127.0.0.1/*'] });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'STATUS_PUSH', data: s }).catch(() => {});
}

// ---------- WhatsApp tab ----------
async function getWaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: false, pinned: true });
}

function sendUrl(job) {
  const u = new URL('https://web.whatsapp.com/send');
  u.searchParams.set('phone', job.phone);
  if (!job.image && job.text) u.searchParams.set('text', job.text);
  u.searchParams.set('type', 'phone_number');
  u.searchParams.set('app_absent', '0');
  return u.toString();
}

// ---------- scheduler ----------
async function ensureAlarm() {
  const a = await chrome.alarms.get(TICK);
  if (!a) chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
}

async function tick(force = false) {
  const { campaign, run = {}, optout = [] } = await get(['campaign', 'run', 'optout']);
  if (!campaign) return;
  const now = Date.now();
  const s = campaign.settings || {};

  // stuck send?
  if (run.current) {
    if (now - run.current.startedAt > SEND_TIMEOUT_MS) {
      await finish(run.current.jobId, false, 'TIMEOUT (WhatsApp tab did not respond)');
    }
    return;
  }

  const hasTest = campaign.jobs.some(j => j.test && j.status === 'pending');
  if (!run.running && !hasTest) return;

  let job;
  if (hasTest) {
    job = campaign.jobs.find(j => j.test && j.status === 'pending');
  } else {
    const lp = localParts(now, s.tz);
    const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    if (!force) {
      if (!days.includes(lp.weekday)) return;
      if (lp.minutes < hm(s.windowStart || '10:00') || lp.minutes >= hm(s.windowEnd || '19:00')) return;
      const today = (run.daily || {})[dayKey(now, s.tz)] || 0;
      const cap = Math.min(s.perDay || 30, HARD_DAILY_CAP);
      if (today >= cap) return;
      if (run.nextAllowedAt && now < run.nextAllowedAt) return;
    }
    const pending = campaign.jobs.filter(j => j.status === 'pending' && !j.test && (force || j.at <= now)).sort((a, b) => a.at - b.at);
    job = pending[0];
    if (!job) {
      if (!campaign.jobs.some(j => j.status === 'pending')) {
        run.running = false;
        await set({ run });
        await log('info', 'Campaign complete – all messages processed.');
        pushStatus();
      }
      return;
    }
  }

  if (optout.includes(job.phone)) {
    job.status = 'skipped'; job.error = 'Opted out';
    await set({ campaign });
    await log('warn', `Skipped ${job.phone} (opt-out list)`);
    pushStatus();
    return;
  }

  // start sending
  const tab = await getWaTab();
  job.status = 'sending';
  job.attempts = (job.attempts || 0) + 1;
  run.current = { jobId: job.id, tabId: tab.id, startedAt: now, dispatched: false };
  await set({ campaign, run });
  await log('info', `Opening chat ${job.phone}${job.test ? ' (test)' : ''}…`);
  await chrome.tabs.update(tab.id, { url: sendUrl(job) });
  pushStatus();
}

async function finish(jobId, ok, error) {
  const { campaign, run = {} } = await get(['campaign', 'run']);
  if (!campaign) return;
  const job = campaign.jobs.find(j => j.id === jobId);
  const s = campaign.settings || {};
  const now = Date.now();
  if (job) {
    if (ok) {
      job.status = 'sent'; job.sentAt = now; job.error = '';
      if (!job.test) {
        run.daily = run.daily || {};
        const k = dayKey(now, s.tz);
        run.daily[k] = (run.daily[k] || 0) + 1;
        const minG = (s.minGapMin || 8) * 60000, maxG = (s.maxGapMin || 15) * 60000;
        run.nextAllowedAt = now + rand(minG, Math.max(minG, maxG));
      }
      await log('ok', `Sent to ${job.phone}${job.test ? ' (test)' : ''}`);
    } else {
      const permanent = /INVALID_NUMBER|NOT_ON_WHATSAPP/.test(error || '');
      if (/NOT_LOGGED_IN/.test(error || '')) {
        job.status = 'pending'; job.attempts = Math.max(0, (job.attempts || 1) - 1);
        run.running = false; run.pausedReason = 'WhatsApp Web is not logged in. Open web.whatsapp.com, scan the QR, then press Resume.';
        await log('error', run.pausedReason);
      } else if (!permanent && (job.attempts || 0) < 2 && !job.test) {
        job.status = 'pending'; job.at = now + 5 * 60000; job.error = error;
        await log('warn', `Retry later for ${job.phone}: ${error}`);
      } else {
        job.status = 'failed'; job.error = error;
        await log('error', `Failed ${job.phone}: ${error}`);
      }
      // small breather after a failure too
      run.nextAllowedAt = now + 60000;
    }
  }
  run.current = null;
  await set({ campaign, run });
  pushStatus();
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const p = msg.payload || {};
    switch (msg.type) {
      case 'STATUS': return status(true);

      case 'LOAD_CAMPAIGN': {
        const { campaign, images } = p;
        if (!campaign || !Array.isArray(campaign.jobs)) return { ok: false, error: 'Bad campaign' };
        const { run: oldRun = {} } = await get('run');
        if (oldRun.current && Date.now() - oldRun.current.startedAt < SEND_TIMEOUT_MS) {
          return { ok: false, error: 'A message is being sent right now – try again in ~30 seconds.' };
        }
        campaign.jobs.forEach(j => { j.status = j.status || 'pending'; j.attempts = 0; });
        await set({ campaign, images: images || {}, run: { running: false, current: null, nextAllowedAt: 0, daily: oldRun.daily || {} } });
        await log('info', `Loaded campaign "${campaign.name}" with ${campaign.jobs.length} messages.`);
        await ensureAlarm();
        pushStatus();
        return { ok: true };
      }

      case 'START': {
        const { run = {}, campaign } = await get(['run', 'campaign']);
        if (!campaign) return { ok: false, error: 'No campaign loaded' };
        run.running = true; run.pausedReason = '';
        await set({ run });
        await ensureAlarm();
        await log('info', 'Campaign started.');
        tick();
        pushStatus();
        return { ok: true };
      }

      case 'PAUSE': {
        const { run = {} } = await get('run');
        run.running = false; run.pausedReason = 'Paused by you.';
        await set({ run });
        await log('info', 'Campaign paused.');
        pushStatus();
        return { ok: true };
      }

      case 'CLEAR': {
        await set({ campaign: null, images: {}, run: { running: false, current: null, nextAllowedAt: 0, daily: {} } });
        await log('info', 'Campaign cleared.');
        pushStatus();
        return { ok: true };
      }

      case 'RETRY_FAILED': {
        const { campaign } = await get('campaign');
        if (!campaign) return { ok: false };
        let n = 0;
        campaign.jobs.forEach(j => { if (j.status === 'failed') { j.status = 'pending'; j.attempts = 0; j.at = Date.now(); n++; } });
        await set({ campaign });
        await log('info', `Re-queued ${n} failed messages.`);
        pushStatus();
        return { ok: true, n };
      }

      case 'SEND_NEXT_NOW': {
        await tick(true);
        return { ok: true };
      }

      case 'TEST_SEND': {
        let { campaign, images = {} } = await get(['campaign', 'images']);
        if (!campaign) campaign = { id: 'test', name: 'Test', settings: { tz: p.tz }, jobs: [] };
        const id = 'test-' + Date.now();
        if (p.imageData) { images['__test__'] = p.imageData; }
        campaign.jobs.unshift({ id, phone: p.phone, name: 'Test', text: p.text || '', image: p.imageData ? '__test__' : null, at: Date.now(), status: 'pending', test: true, attempts: 0 });
        await set({ campaign, images });
        await ensureAlarm();
        await tick(true);
        return { ok: true, id };
      }

      case 'SET_OPTOUT': {
        await set({ optout: (p.list || []).map(String) });
        return { ok: true };
      }

      // ---- from WhatsApp tab ----
      case 'WA_READY': {
        const { run = {}, campaign, images = {} } = await get(['run', 'campaign', 'images']);
        const cur = run.current;
        if (!cur || !campaign || !sender.tab || sender.tab.id !== cur.tabId) return { job: null };
        if (cur.dispatched) return { job: null };
        const job = campaign.jobs.find(j => j.id === cur.jobId);
        if (!job) return { job: null };
        const url = new URL(p.url || 'https://x/');
        if (url.pathname === '/send' && url.searchParams.get('phone') && url.searchParams.get('phone') !== job.phone) return { job: null };
        cur.dispatched = true;
        await set({ run });
        return { job: { id: job.id, phone: job.phone, text: job.text, image: job.image ? images[job.image] || null : null, imageName: job.image || null } };
      }

      case 'WA_RESULT': {
        await finish(p.jobId, !!p.ok, p.error || '');
        // next message might already be allowed (e.g. queued test sends)
        setTimeout(() => tick(), 1500);
        return { ok: true };
      }

      case 'WA_LOG': {
        await log(p.level || 'info', '[WA] ' + p.msg);
        return { ok: true };
      }

      default:
        return { ok: false, error: 'Unknown message ' + msg.type };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === TICK) tick(); });
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'https://gauravsri1020.github.io/wa-campaign-scheduler/' }));
