// The dashboard: what the app is doing, the conversation, the device, and
// the toolkit profile. It talks to this laptop's server (/api/...).

import { createTour } from './tour.js';

const $ = (id) => document.getElementById(id);
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let state = null;
let token = '';

// ── header: phase and Start/Stop ────────────────────────────────────────────
const PHASE_TEXT = { off: 'Off', idle: 'Ready', listening: 'Listening', thinking: 'Working', speaking: 'Speaking' };

function renderState(s) {
  state = s;
  document.title = `${s.app} · XR Starter`;
  $('app-name').textContent = s.app;
  if (s.file) document.querySelector('.file code').textContent = s.file;
  $('phase').dataset.phase = s.phase;
  // While running, the status line names the phase and adds detail ("Taking a photo").
  $('phase-text').textContent = s.active ? s.status || PHASE_TEXT[s.phase] : 'Off';
  const btn = $('startstop');
  btn.disabled = !s.device && !s.active;
  btn.textContent = s.active ? '■ Stop' : '▶ Start';
  btn.className = s.active ? 'stop' : 'primary';
  btn.title = s.device ? '' : 'Connect the phone first';

  const problem = $('problem');
  problem.hidden = !s.problem;
  problem.firstElementChild.textContent = s.problem ?? '';

  const c = $('connected');
  const g = s.device?.glasses;
  if (!s.device) [c.textContent, c.className] = ['Not connected', 'badge'];
  else if (s.device.kind !== 'glasses') [c.textContent, c.className] = ['✓ The phone, as the glasses', 'badge ok'];
  else if (g?.connected) [c.textContent, c.className] = [`✓ Glasses connected${g.battery != null ? ` · ${g.battery}%` : ''}`, 'badge ok'];
  else [c.textContent, c.className] = ['Phone connected. Waiting for the glasses.', 'badge warn'];
  // Under the QR code: has the phone scanned it? The phone shows the next step.
  const phoneOn = !!s.device;
  $('phone-state').dataset.on = String(phoneOn);
  $('phone-state-text').textContent = phoneOn ? 'Phone connected. Continue on the phone.' : 'Waiting for the phone…';

  $('adapt').setAttribute('aria-checked', String(s.adapt));
  $('adapt').textContent = s.adapt ? 'On' : 'Off';

  const gm = s.gemini;
  $('gemini-status').textContent = !gm.key
    ? 'Gemini key missing: add GEMINI_API_KEY to .env'
    : gm.off
      ? `Gemini is switched off: ${gm.off}`
      : `Gemini: ${gm.calls} calls since start`;
  tour.refresh();
}

$('startstop').onclick = () => post('/api/control', { action: state?.active ? 'stop' : 'start' });

// ── conversation ────────────────────────────────────────────────────────────
const log = $('log');
function add(cls, who, text, extra) {
  const li = document.createElement('li');
  li.className = cls;
  if (who) {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    li.append(w);
  }
  const t = document.createElement('span');
  t.className = 'text';
  t.textContent = text;
  li.append(t);
  if (extra) li.append(extra);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.append(li);
  while (log.children.length > 400) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onEvent(e) {
  switch (e.type) {
    case 'state':
      return renderState(e.state);
    case 'you':
      return add(`you${e.ignored ? ' ignored' : ''}`, `You · ${time(e.at)}`, e.text + (e.ignored ? `  (not handled: ${e.ignored})` : ''));
    case 'app':
      return add('app', `App · ${time(e.at)}`, e.text);
    case 'photo': {
      const img = document.createElement('img');
      img.src = `/api/photo/${e.id}.jpg`;
      img.alt = `Photo from the ${e.from === 'glasses' ? 'glasses camera' : e.from === 'phone' ? 'phone camera' : 'webcam'}`;
      return add('photo', `Photo · ${time(e.at)}`, '', img);
    }
    case 'button':
      return add('button', '', `Button: ${e.press} press · ${time(e.at)}`);
    case 'log':
      return add(e.level, e.level === 'info' ? '' : e.level === 'warn' ? 'Warning' : 'Error', e.text);
    case 'profile':
      return void loadProfile();
  }
}

function listen() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {
    // The server restarted (a file was saved). The browser reconnects on its own;
    // the history arrives again, so start the list fresh.
    es.close();
    setTimeout(() => {
      log.replaceChildren();
      listen();
    }, 800);
  };
}

const say = (text) => post('/api/control', { action: 'type', text });
$('say-form').onsubmit = (ev) => {
  ev.preventDefault();
  const text = $('say').value.trim();
  if (!text) return;
  say(text);
  $('say').value = '';
};
$('clear').onclick = () => log.replaceChildren();
$('announce').onchange = (e) => log.setAttribute('aria-live', e.target.checked ? 'polite' : 'off');

// ── connect: the QR code for the phone ─────────────────────────────────────
async function loadConnect() {
  const c = await fetch('/api/connect').then((r) => r.json());
  token = c.token;
  $('token').textContent = c.token;
  $('addr').textContent = c.url ?? 'No network address found. Join a Wi-Fi network, or run bun run tunnel.';
  if (c.qr) $('qr').innerHTML = c.qr;
  // Where to get the phone app. Without a link, the card asks the organiser.
  for (const [os, app] of Object.entries(c.apps ?? {})) {
    const fig = $(`app-${os}`);
    if (!fig) continue;
    fig.querySelector('.app-qr').hidden = !app;
    fig.querySelector('a').hidden = !app;
    if (app) {
      fig.querySelector('.app-qr').innerHTML = app.qr;
      fig.querySelector('a').href = app.url;
    } else fig.querySelector('figcaption').innerHTML = `<b>${os === 'ios' ? 'iPhone' : 'Android'}</b><br>Ask the organiser.`;
  }
  $('addr-how').textContent =
    c.how === 'tunnel' ? 'Using the tunnel: works from other networks too.'
    : c.how === 'PUBLIC_URL' ? 'Using PUBLIC_URL from .env.'
    : c.how === 'wifi' ? 'The phone needs to be on the same Wi-Fi as this laptop.'
    : '';
}

// ── the profile (toolkit) ──────────────────────────────────────────────────
// The dashboard shows a few needs as examples (showOnDashboard in
// src/toolkit/needs.ts). Others that an app or an example saved are listed
// below them in one line.
$('adapt').onclick = () => post('/api/control', { action: 'adapt', on: !(state?.adapt ?? true) });

async function loadProfile() {
  renderProfile(await fetch('/api/profile').then((r) => r.json()));
}

const shownValue = (n) =>
  n.kind === 'toggle' ? (n.value ? 'on' : 'off') : n.kind === 'choice' ? (n.options.find((o) => o.value === n.value)?.label ?? n.value) : `${n.value}${n.unit ?? ''}`;

function needRow(n) {
  const row = document.createElement('div');
  row.className = 'need';
  row.id = `row-${n.key}`;
  const id = `need-${n.key}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = n.label;
  let control;
  if (n.kind === 'toggle') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = !!n.value;
    control.onchange = () => saveNeed(n.key, control.checked);
  } else if (n.kind === 'choice') {
    control = document.createElement('select');
    control.append(...n.options.map((o) => new Option(o.label, o.value)));
    control.value = String(n.value);
    control.onchange = () => saveNeed(n.key, control.value);
  } else {
    control = document.createElement('span');
    const range = document.createElement('input');
    range.type = 'range';
    Object.assign(range, { min: n.min, max: n.max, step: n.step, value: n.value, id });
    const out = document.createElement('output');
    out.htmlFor = id;
    out.textContent = `${Number(n.value).toFixed(1)}${n.unit ?? ''}`;
    range.oninput = () => (out.textContent = `${Number(range.value).toFixed(1)}${n.unit ?? ''}`);
    range.onchange = () => saveNeed(n.key, Number(range.value));
    control.append(range, ' ', out);
  }
  if (control.tagName !== 'SPAN') control.id = id;
  row.append(label, control);
  return row;
}

function renderProfile(p) {
  $('needs').replaceChildren(...p.needs.filter((n) => n.showOnDashboard !== false).map(needRow));

  const ex = $('examples');
  if (!ex.children.length) {
    ex.replaceChildren(
      ...p.examples.map((e) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = e.label;
        b.onclick = () => post('/api/profile/example', { key: e.key }).then(renderProfile);
        return b;
      }),
    );
  }

  const more = [
    ...p.needs.filter((n) => n.showOnDashboard === false && n.set).map((n) => `${n.label}: ${shownValue(n)}`),
    ...p.other.map((n) => `${n.dimension}: ${JSON.stringify(n.value)}`),
  ];
  $('other-needs').textContent = `Also in the profile: ${more.join(', ')}`;
  $('other-needs').hidden = !more.length;
  tour.refresh();
}

// ── people: the active profile, and its prompts ─────────────────
let people = null;
const current = () => people?.people.find((p) => p.id === people.active);

async function loadPeople() {
  people = await fetch('/api/people').then((r) => r.json());
  renderPeople();
}

function renderPeople() {
  $('person').replaceChildren(...people.people.map((p) => new Option(p.name, p.id)));
  $('person').value = people.active;
  $('person-notes').value = current().notes ?? '';
  renderFaq('entry');
  renderFaq('continuous');
}

function saveFaq(field) {
  const person = current();
  return post('/api/people/save', { id: person.id, [field]: person[field] });
}

function renderFaq(field, focusAt) {
  const person = current();
  const rows = person[field].map((text, i) => {
    const li = document.createElement('li');
    const number = document.createElement('span');
    number.textContent = `${i + 1}.`;
    number.setAttribute('aria-hidden', 'true');
    const input = document.createElement('textarea');
    input.rows = 2;
    input.value = text;
    input.setAttribute('aria-label', `Prompt ${i + 1}`);
    input.onchange = () => {
      person[field][i] = input.value;
      void saveFaq(field);
    };
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move prompt ${i + 1} up`);
    up.onclick = () => {
      [person[field][i - 1], person[field][i]] = [person[field][i], person[field][i - 1]];
      void saveFaq(field);
      renderFaq(field, i - 1);
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Remove prompt ${i + 1}`);
    remove.onclick = () => {
      person[field].splice(i, 1);
      void saveFaq(field);
      renderFaq(field);
    };
    li.append(number, input, up, remove);
    return li;
  });
  $(`faq-${field}`).replaceChildren(...rows);
  if (focusAt != null) rows[focusAt]?.querySelector('textarea')?.focus();
}

for (const field of ['entry', 'continuous']) {
  $(`add-${field}`).onclick = () => {
    current()[field].push('');
    renderFaq(field, current()[field].length - 1);
  };
}
$('person').onchange = () =>
  post('/api/people/select', { id: $('person').value }).then((r) => {
    if (!r.people) return alert(r.error);
    people = r;
    renderPeople();
    return loadProfile();
  });
$('person-add').onclick = () => {
  const name = prompt('Name for the new profile');
  if (!name) return;
  post('/api/people/add', { name }).then((r) => {
    if (!r.people) return alert(r.error);
    people = r;
    renderPeople();
    return loadProfile();
  });
};
$('person-notes').onchange = () => post('/api/people/save', { id: people.active, notes: $('person-notes').value });

function saveNeed(key, value) {
  return post('/api/profile/need', { key, value }).then((r) => (r.needs ? renderProfile(r) : alert(r.error)));
}

// ── the tour ────────────────────────────────────────────────────────────────
const connected = () => !!state?.device;
const running = () => !!state?.active;
const tour = createTour(
  [
    {
      target: '#app-info',
      title: 'Your app',
      text: 'This page runs your app, the file src/app.ts. Save a change to it, and the app restarts here.',
    },
    {
      target: '#card-glasses',
      title: 'Connect your phone',
      text: 'Open XR Starter on the phone and scan this QR code. The phone then connects the glasses, or acts as the glasses itself.',
    },
    {
      target: '#startstop',
      title: 'Start',
      text: 'Start runs your app. This app greets the wearer first.',
      do: { label: 'Press Start', run: () => post('/api/control', { action: 'start' }), ready: connected, done: running, notReady: 'Connect the phone first, in the step before.' },
    },
    {
      target: '#card-convo',
      title: 'Talk or type',
      text: 'Talk to the app, or type below. What it hears, says and sees shows here.',
      do: { label: 'Ask “What is in front of me?”', run: () => say('What is in front of me?'), ready: running, notReady: 'Press Start first.' },
    },
    {
      target: '#card-profile',
      title: 'The profile',
      text: 'The AI for Accessibility Toolkit keeps what the wearer needs, and the app follows it. Try a slower speed, then ask again. The Tour button opens this tour again.',
    },
  ],
  {
    onEnd: () => {
      try {
        localStorage.setItem('xr-tour-seen', '1');
      } catch {}
    },
  },
);
$('tour-btn').onclick = () => tour.start();

// ── go ──────────────────────────────────────────────────────────────────────
listen();
void loadConnect();
void loadProfile();
void loadPeople();
setInterval(() => void loadConnect().catch(() => {}), 10_000);
let seen = false;
try {
  seen = localStorage.getItem('xr-tour-seen') === '1';
} catch {}
if (!seen) setTimeout(() => tour.start(), 600);

// ── the live camera ──────────────────────────────────────────────────────────
// While the glasses stream video (an app with camera: 'live' or onFrame), the
// glasses card shows the newest frame, refreshed once a second, so a team
// can see what the app sees.
{
  const img = $('live-frame');
  img.onerror = () => (img.hidden = true); // no frame yet
  setInterval(() => {
    const on = state?.camera === 'live';
    if (!on) img.hidden = true;
    else img.src = `/api/frame.jpg?t=${Date.now()}`;
  }, 1000);
  img.onload = () => (img.hidden = state?.camera !== 'live');
}
