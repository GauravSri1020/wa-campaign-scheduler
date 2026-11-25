// WA Campaign Scheduler – official WhatsApp Cloud API sender (runs in GitHub Actions, no dependencies)
// Reads data/campaign.enc.json (encrypted in the browser) + data/state.json, sends what is due,
// respecting window, daily cap and random gaps, then writes state.json back.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const DATA = process.env.DATA_DIR || 'data';
const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const KEY = process.env.CAMPAIGN_KEY;
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 8 * 60 * 1000); // cron runs every 10 min
const DRY = process.env.DRY_RUN === '1';
const HARD_DAILY_CAP = 250;
const started = Date.now();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

async function decrypt(enc, pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

function local(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

function addLog(state, msg) {
  console.log(msg);
  state.log = state.log || [];
  state.log.push({ t: Date.now(), msg });
  if (state.log.length > 200) state.log = state.log.slice(-200);
}

async function graph(path, body, isForm = false) {
  if (DRY) { console.log('[dry-run] POST', path, isForm ? '(form)' : JSON.stringify(body).slice(0, 300)); return { messages: [{ id: 'dry-' + Date.now() }], id: 'dry-media' }; }
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
    body: isForm ? body : JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${e.code || r.status} ${e.message || r.statusText}${e.error_data?.details ? ' – ' + e.error_data.details : ''}`);
  }
  return j;
}

async function mediaId(state, key, dataUrl) {
  state.media = state.media || {};
  const cached = state.media[key];
  if (cached && Date.now() - cached.t < 25 * 24 * 3600 * 1000) return cached.id; // media ids live ~30 days
  const [, mime, data] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime || 'image/jpeg');
  form.append('file', new Blob([Buffer.from(data, 'base64')], { type: mime || 'image/jpeg' }), key.replace(/\.\w+$/, '') + '.jpg');
  const j = await graph(`${PHONE_ID}/media`, form, true);
  state.media[key] = { id: j.id, t: Date.now() };
  return j.id;
}

async function sendOne(c, job, state) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: job.phone };
  const img = job.image && c.images[job.image] ? await mediaId(state, job.image, c.images[job.image]) : null;
  let body;
  if (c.message.type === 'template') {
    const components = [];
    if (img) components.push({ type: 'header', parameters: [{ type: 'image', image: { id: img } }] });
    if (job.params && job.params.length) components.push({ type: 'body', parameters: job.params.map(t => ({ type: 'text', text: String(t) })) });
    body = { ...base, type: 'template', template: { name: c.message.template, language: { code: c.message.lang || 'en' }, ...(components.length ? { components } : {}) } };
  } else if (img) {
    body = { ...base, type: 'image', image: { id: img, ...(job.text ? { caption: job.text.slice(0, 1024) } : {}) } };
  } else {
    body = { ...base, type: 'text', text: { body: job.text, preview_url: true } };
  }
  const j = await graph(`${PHONE_ID}/messages`, body);
  return j.messages?.[0]?.id || '';
}

async function main() {
  const encPath = `${DATA}/campaign.enc.json`, statePath = `${DATA}/state.json`;
  if (!existsSync(encPath)) return console.log('No campaign uploaded yet – nothing to do.');
  if (!KEY) return console.log('CAMPAIGN_KEY secret missing – nothing to do.');
  if (!DRY && (!TOKEN || !PHONE_ID)) return console.log('WA_TOKEN / WA_PHONE_NUMBER_ID secrets missing – nothing to do.');

  let c;
  try { c = await decrypt(JSON.parse(await readFile(encPath, 'utf8')), KEY); }
  catch { return console.log('Could not decrypt campaign – CAMPAIGN_KEY does not match the passphrase used in the dashboard.'); }

  let state = existsSync(statePath) ? JSON.parse(await readFile(statePath, 'utf8')) : {};
  if (state.campaignId !== c.id) state = { campaignId: c.id, sent: {}, failed: {}, daily: {}, media: {}, nextAllowedAt: 0, log: [] };
  state.sent ||= {}; state.failed ||= {}; state.daily ||= {}; state.attempts ||= {};

  const s = c.settings; const tz = s.tz || 'Asia/Kolkata';
  const cap = Math.min(s.perDay || 30, HARD_DAILY_CAP);
  let changed = false;

  while (Date.now() - started < RUN_BUDGET_MS) {
    const now = Date.now(); const L = local(now, tz);
    if (!(s.days || [0, 1, 2, 3, 4, 5, 6]).includes(L.weekday)) { console.log('Not a sending day.'); break; }
    if (L.minutes < hm(s.windowStart) || L.minutes >= hm(s.windowEnd)) { console.log('Outside sending window.'); break; }
    if ((state.daily[L.day] || 0) >= cap) { console.log('Daily cap reached.'); break; }
    if (state.nextAllowedAt && now < state.nextAllowedAt) {
      const wait = state.nextAllowedAt - now;
      if (Date.now() - started + wait > RUN_BUDGET_MS) { console.log(`Next send allowed at ${new Date(state.nextAllowedAt).toISOString()}.`); break; }
      await sleep(wait); continue;
    }
    const job = c.jobs.find(j => !state.sent[j.i] && !state.failed[j.i] && j.at <= now);
    if (!job) {
      const left = c.jobs.filter(j => !state.sent[j.i] && !state.failed[j.i]).length;
      console.log(left ? `${left} messages waiting for their scheduled time.` : 'Campaign complete.');
      break;
    }
    try {
      const id = await sendOne(c, job, state);
      state.sent[job.i] = { t: Date.now(), id };
      state.daily[L.day] = (state.daily[L.day] || 0) + 1;
      addLog(state, `#${job.i + 1} sent (…${job.phone.slice(-4)})`);
    } catch (e) {
      const msg = String(e.message || e);
      state.attempts[job.i] = (state.attempts[job.i] || 0) + 1;
      // auth / config errors: stop the run instead of burning through the list
      if (/^(190|0|10|100|132001|132000|131031|131042|131056|130429)\b/.test(msg) && state.attempts[job.i] < 3) {
        addLog(state, `#${job.i + 1} paused – ${msg}`);
        changed = true; break;
      }
      state.failed[job.i] = { t: Date.now(), err: msg };
      addLog(state, `#${job.i + 1} failed (…${job.phone.slice(-4)}): ${msg}`);
    }
    const minG = (s.minGapMin || 8) * 60000, maxG = Math.max(minG, (s.maxGapMin || 15) * 60000);
    state.nextAllowedAt = Date.now() + minG + Math.random() * (maxG - minG);
    changed = true;
  }

  if (changed) await writeFile(statePath, JSON.stringify(state, null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
