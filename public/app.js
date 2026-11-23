import { I } from './icons.js';

// ============================================================ state

const S = {
  auth: null,          // { needsSetup, signedIn, name, demo }
  state: null,         // /api/state payload
  route: { name: 'home', params: {} },
  ui: {
    showsFilter: 'remind',
    showsQuery: '',
    onbStep: 0,
    popular: null,
    venueResults: null,
    artistResults: null,
    suggested: null,
    codeEdit: null,     // sale id whose code input is open
    sheet: null,        // { kind, ... }
    sheetResults: null,
    invite: null,
  },
  loading: true,
};

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ============================================================ helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const now = () => Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const tz = () => S.state?.me?.prefs?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

function fmt(ms, opts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), ...opts }).format(new Date(ms));
}
const fmtTime = (ms) => fmt(ms, { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?/i, (_, a) => ` ${a.toUpperCase()}M`);
const dayKey = (ms) => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });

function fmtDay(ms) {
  const k = dayKey(ms);
  if (k === dayKey(now())) return 'Today';
  if (k === dayKey(now() + DAY)) return 'Tomorrow';
  const diff = ms - now();
  if (diff > 0 && diff < 6 * DAY) return fmt(ms, { weekday: 'long' });
  return fmt(ms, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtLocalDate(d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!d) return 'Date TBA';
  const [y, m, dd] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, dd)));
}

function relTime(ms) {
  const d = ms - now();
  const a = Math.abs(d);
  const unit = a < HOUR ? [Math.max(1, Math.round(a / MIN)), 'min'] : a < DAY ? [Math.round(a / HOUR), 'h'] : [Math.round(a / DAY), 'd'];
  return d >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}

function ago(ms) {
  if (!ms) return 'never';
  const a = now() - ms;
  if (a < MIN) return 'just now';
  if (a < HOUR) return `${Math.round(a / MIN)} min ago`;
  if (a < DAY) return `${Math.round(a / HOUR)} h ago`;
  return `${Math.round(a / DAY)} d ago`;
}

function countdownParts(ms) {
  const d = Math.max(0, ms - now());
  const days = Math.floor(d / DAY);
  const h = Math.floor((d % DAY) / HOUR);
  const m = Math.floor((d % HOUR) / MIN);
  const s = Math.floor((d % MIN) / 1000);
  if (days > 0) return `${days}<span class="unit">d</span>${h}<span class="unit">h</span>`;
  if (h > 0) return `${h}<span class="unit">h</span>${String(m).padStart(2, '0')}<span class="unit">m</span>`;
  return `${m}<span class="unit">m</span>${String(s).padStart(2, '0')}<span class="unit">s</span>`;
}

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let toastTimer;
function toast(msg, undo) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-act="toast-undo">Undo</button>' : ''}`;
  toastEl._undo = undo;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), undo ? 5000 : 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    S.auth = { ...(S.auth ?? {}), signedIn: false };
    S.state = null;
    render();
    throw new Error('signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ============================================================ data access

function shows() {
  return S.state?.shows ?? [];
}
function findShow(id) {
  return shows().find((s) => s.id === id) ?? S.state?.hidden?.find((s) => s.id === id) ?? null;
}
function findSale(saleId) {
  if (S.guest) {
    const sale = S.guest.show.sales.find((x) => x.id === saleId);
    if (sale) return { show: S.guest.show, sale };
  }
  for (const show of [...shows(), ...(S.state?.hidden ?? [])]) {
    const sale = show.sales.find((s) => s.id === saleId);
    if (sale) return { show, sale };
  }
  return null;
}

/** A sale is still actionable for a while after it opens. */
function saleOpenUntil(sale) {
  return sale.endUtc && sale.endUtc > sale.startUtc ? Math.min(sale.endUtc, sale.startUtc + 6 * HOUR) : sale.startUtc + 3 * HOUR;
}

/** One entry per show you get reminders for: its next sale (or the one open now), soonest first. */
function mySales() {
  const out = [];
  for (const show of shows()) {
    if (show.level !== 'remind' || show.gotTickets || show.status === 'canceled') continue;
    const live = show.sales.filter((s) => s.startUtc && saleOpenUntil(s) >= now()).sort((a, b) => a.startUtc - b.startUtc);
    if (!live.length) continue;
    out.push({ show, sale: live[0], later: live.slice(1) });
  }
  return out.sort((a, b) => a.sale.startUtc - b.sale.startUtc);
}

function newAtVenues() {
  return shows()
    .filter((s) => s.level === 'feed' && s.isNew && !s.gotTickets)
    .sort((a, b) => b.firstSeen - a.firstSeen);
}

function salePhase(sale) {
  const t = now();
  if (t >= sale.startUtc) return t < saleOpenUntil(sale) ? 'open' : 'over';
  return sale.startUtc - t <= 30 * MIN ? 'soon' : 'prep';
}

function accessLine(sale, { compact = false } = {}) {
  const best = sale.codes?.[0];
  if (best) {
    const tag =
      best.source === 'you' || best.source === 'saved'
        ? ''
        : best.source === 'ticketmaster'
          ? '<span class="pill good">from Ticketmaster</span>'
          : `<span class="pill ${best.confidence === 'high' ? 'good' : best.confidence === 'medium' ? 'warn' : ''}">${best.source === 'livenation' ? 'Live Nation' : 'found online'}</span>`;
    const more = sale.codes.length > 1 && !compact ? `<span class="faint">+${sale.codes.length - 1} backup</span>` : '';
    return `<div class="access">${I.key}<span class="code">${esc(best.code)}</span>${tag}${more}</div>`;
  }
  if (sale.kind === 'public') return compact ? '' : `<div class="access">${I.ticket}Public sale, no code needed</div>`;
  const map = {
    card: [I.card, 'No code needed, just the eligible card'],
    register: [I.flag, 'Registration required'],
    code: [I.key, 'Needs a code. Searching for one'],
    none: [I.ticket, 'Open access'],
    unknown: [I.info, 'Check the presale details'],
  };
  const [ic, text] = map[sale.requirement] ?? map.unknown;
  return `<div class="access ${sale.requirement === 'register' ? 'warn' : ''}">${ic}${esc(text)}</div>`;
}

// ============================================================ routing

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  const param = decodeURIComponent(rest.join('/'));
  switch (name) {
    case '':
      return { name: 'home', params: {} };
    case 'shows':
    case 'activity':
    case 'settings':
      return { name, params: {} };
    case 'show':
      return { name: 'show', params: { id: param } };
    case 'go':
      return { name: 'go', params: { saleId: param } };
    case 'join':
      return { name: 'join', params: { token: param } };
    case 'review':
      return { name: 'review', params: {} };
    case 'link':
      return { name: 'link', params: { u: Number(rest[0]), saleId: decodeURIComponent(rest[1] ?? ''), sig: rest[2] ?? '' } };
    default:
      return { name: 'home', params: {} };
  }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  S.route = parseRoute();
  if (S.route.name !== 'review') S.ui.deck = null;
  S.ui.codeEdit = null;
  render();
  window.scrollTo(0, 0);
});

// ============================================================ loading

async function loadAuth() {
  S.auth = await api('/api/auth/status');
}

async function loadState() {
  S.state = await api('/api/state');
}

async function refresh() {
  try {
    await loadState();
    render();
  } catch (e) {
    if (e.message !== 'signed out') console.warn(e);
  }
}

async function boot() {
  S.route = parseRoute();
  try {
    await loadAuth();
    if (S.auth.signedIn) await loadState();
  } catch (e) {
    console.error(e);
  }
  S.loading = false;
  render();
  registerSW();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.state) refresh();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && S.state && !S.ui.sheet && !document.activeElement?.matches('input')) refresh();
}, 60_000);

// Live countdowns without re-rendering the page.
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const t = Number(el.dataset.countdown);
    if (t - now() <= 0 && el.dataset.reload !== 'done') {
      el.dataset.reload = 'done';
      render();
      return;
    }
    el.innerHTML = countdownParts(t);
  });
  document.querySelectorAll('[data-rel]').forEach((el) => (el.textContent = relTime(Number(el.dataset.rel))));
}, 1000);

// ============================================================ render root

function render() {
  if (S.loading) {
    app.innerHTML = `<div class="center"><div class="spinner"></div></div>`;
    return;
  }
  if (S.route.name === 'link') return renderLink();
  if (S.route.name === 'join' && !S.auth?.signedIn) return renderJoin();
  if (!S.auth?.signedIn) return S.auth?.needsSetup ? renderSetup() : renderLogin();
  if (!S.state) {
    app.innerHTML = `<div class="center"><div class="spinner"></div></div>`;
    return;
  }
  if (!S.state.me.onboarded) return renderOnboarding();

  let body = '';
  switch (S.route.name) {
    case 'shows':
      body = viewShows();
      break;
    case 'activity':
      body = viewActivity();
      break;
    case 'settings':
      body = viewSettings();
      break;
    case 'show':
      body = viewShow(S.route.params.id);
      break;
    case 'go':
      body = viewGo(S.route.params.saleId);
      break;
    case 'review':
      body = viewReview();
      break;
    default:
      body = viewHome();
  }
  const tabs = !['show', 'go', 'review'].includes(S.route.name);
  app.innerHTML = body + (tabs ? tabBar() : '') + sheetHtml();
  afterRender();
}

let wakeLock = null;
async function syncWakeLock() {
  const want = !!document.querySelector('[data-launch]');
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

function afterRender() {
  syncWakeLock();
  bindDeck();
  if (!S.state) return;
  if (S.route.name === 'activity' && S.state.activity.some((a) => !a.read)) {
    api('/api/activity/read', { body: {} })
      .then(() => S.state.activity.forEach((a) => (a.read = true)))
      .catch(() => {});
  }
  bindSwipes();
}

function tabBar() {
  const unread = S.state.activity.some((a) => !a.read);
  const tab = (name, hash, icon, label, dot = false) =>
    `<button class="tab ${S.route.name === name ? 'on' : ''}" data-act="nav" data-href="${hash}">${icon}<span>${label}</span>${dot ? '<span class="dot"></span>' : ''}</button>`;
  return `<div class="tabs"><nav>
    ${tab('home', '#/', I.ticket, 'Sales')}
    ${tab('shows', '#/shows', I.music, 'Shows')}
    ${tab('activity', '#/activity', I.bell, 'Activity', unread)}
    ${tab('settings', '#/settings', I.settings, 'Settings')}
  </nav></div>`;
}

// ============================================================ auth screens

function authShell(title, sub, form, footer = '') {
  // iPhone keeps Home Screen apps signed in separately from Safari: install first to sign in once.
  const iosTip =
    isIOS() && !isStandalone()
      ? `<div class="banner small">${I.phone}<span>On iPhone, add this to your Home Screen first (tap ${I.share} then Add to Home Screen) and continue there. That way you only sign in once.</span></div>`
      : '';
  footer = iosTip + footer;
  app.innerHTML = `<div class="welcome">
    <div class="logo">${I.radar}</div>
    <div class="stack" style="gap:8px"><h1>${title}</h1><p class="muted">${sub}</p></div>
    <form class="stack" data-form="${form.id}" novalidate>${form.html}
      <div class="error" id="form-error"></div>
      <button class="btn primary big block" type="submit">${form.cta}</button>
    </form>
    ${footer}
  </div>`;
}

const fields = (list) =>
  list
    .map(
      ([name, label, type, auto, ph]) =>
        `<div class="field"><label for="f-${name}">${label}</label><input class="input" id="f-${name}" name="${name}" type="${type}" autocomplete="${auto}" placeholder="${ph ?? ''}" required></div>`,
    )
    .join('');

function renderSetup() {
  authShell(
    'Never miss a presale',
    "Create your account to start. You're the owner, so you can invite friends later.",
    {
      id: 'setup',
      cta: 'Create account',
      html: fields([
        ['name', 'Your name', 'text', 'name', ''],
        ['email', 'Email', 'email', 'email', 'you@example.com'],
        ['password', 'Password', 'password', 'new-password', 'At least 8 characters'],
      ]),
    },
    S.auth?.demo ? `<p class="faint small" style="text-align:center">Demo mode: shows and artists are made up.</p>` : '',
  );
}

function renderLogin() {
  authShell('Welcome back', 'Sign in to see your presales.', {
    id: 'login',
    cta: 'Sign in',
    html: fields([
      ['email', 'Email', 'email', 'email', 'you@example.com'],
      ['password', 'Password', 'password', 'current-password', ''],
    ]),
  });
}

async function renderJoin() {
  app.innerHTML = `<div class="center"><div class="spinner"></div></div>`;
  let inviter = null;
  try {
    inviter = (await api(`/api/invites/${encodeURIComponent(S.route.params.token)}`)).inviter;
  } catch (e) {
    app.innerHTML = `<div class="welcome"><div class="logo">${I.radar}</div><h1>This invite has expired</h1><p class="muted">${esc(e.message)} Ask for a new link.</p><button class="btn block" data-act="nav" data-href="#/">Sign in instead</button></div>`;
    return;
  }
  authShell(`${esc(inviter)} invited you`, 'Create your account to get presale reminders for the shows you care about.', {
    id: 'join',
    cta: 'Join',
    html: fields([
      ['name', 'Your name', 'text', 'name', ''],
      ['email', 'Email', 'email', 'email', 'you@example.com'],
      ['password', 'Password', 'password', 'new-password', 'At least 8 characters'],
    ]),
  });
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.form;
  const errEl = form.querySelector('.error');
  const btn = form.querySelector('button[type=submit]');
  try {
    btn.disabled = true;
    if (kind === 'setup') await api('/api/auth/setup', { body: data });
    else if (kind === 'login') await api('/api/auth/login', { body: data });
    else if (kind === 'join') await api('/api/auth/join', { body: { ...data, token: S.route.params.token } });
    else if (kind === 'code') return await saveCode(form, data);
    else if (kind === 'venue-page') {
      const r = await api('/api/venue-pages', { body: data });
      await loadState();
      closeSheet();
      return toast(r.error ? `Added, but: ${r.error}` : r.found ? `Found ${r.found} show${r.found === 1 ? '' : 's'}${r.added ? `, ${r.added} not on Ticketmaster` : ''}` : 'Added. No listings found yet.');
    } else if (kind === 'icloud') {
      const r = await api('/api/calendar/icloud', { body: data });
      await loadState();
      closeSheet();
      return toast(`Connected. ${r.synced} sale${r.synced === 1 ? '' : 's'} added to your Presales calendar.`);
    }
    else if (kind === 'source') return await addSource(form, data);
    await loadAuth();
    await loadState();
    if (kind === 'join') location.hash = '#/';
    render();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ============================================================ onboarding

const ONB_STEPS = 4;

function renderOnboarding() {
  const step = S.ui.onbStep;
  const dots = `<div class="steps">${Array.from({ length: ONB_STEPS }, (_, i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>`;
  let body = '';
  let foot = '';
  if (step === 0) {
    if (!S.ui.popular) loadPopular();
    const mine = new Set(S.state.venues.map((v) => v.id));
    const list = S.ui.venueResults ?? S.ui.popular ?? [];
    const extra = S.state.venues.filter((v) => !list.some((p) => p.id === v.id));
    body = `
      <div class="stack" style="gap:8px;margin:18px 0 16px"><h1>Where do you go to shows?</h1>
      <p class="muted">Pick your venues. New shows there appear quietly in your feed and evening roundup.</p></div>
      <div class="search" style="margin-bottom:14px">${I.search}<input class="input" data-search="venues" placeholder="Search any venue" value=""></div>
      ${!S.ui.popular && !S.ui.venueResults ? '<div class="center" style="min-height:160px"><div class="spinner"></div></div>' : ''}
      <div class="venue-grid">${[...extra, ...list].map((v) => venueTile(v, mine.has(v.id))).join('')}</div>`;
    foot = `<button class="btn primary big block" data-act="onb-next">${mine.size ? `Continue with ${mine.size} venue${mine.size > 1 ? 's' : ''}` : 'Skip for now'}</button>`;
  } else if (step === 1) {
    if (!S.ui.suggested) loadSuggested();
    const mine = new Set(S.state.artists.map((a) => a.id));
    const results = S.ui.artistResults;
    const sugg = (S.ui.suggested ?? []).filter((a) => !results);
    body = `
      <div class="stack" style="gap:8px;margin:18px 0 16px"><h1>Who can't you miss?</h1>
      <p class="muted">Artists you pick get reminders before every sale, anywhere near you.</p></div>
      <div class="search" style="margin-bottom:14px">${I.search}<input class="input" data-search="artists" placeholder="Search artists"></div>
      ${(() => {
        const inSugg = new Set((results ? [] : S.ui.suggested ?? []).map((a) => a.id));
        const extra = S.state.artists.filter((a) => !inSugg.has(a.id));
        return extra.length ? `<div class="chips" style="margin-bottom:16px">${extra.map((a) => artistChip(a, true)).join('')}</div>` : '';
      })()}
      ${results ? `<div class="list">${results.length ? results.map((a) => artistRow(a, mine.has(a.id))).join('') : '<div class="item muted">No artists found</div>'}</div>` : ''}
      ${!results && sugg.length ? `<div class="section-head" style="margin-top:6px"><h2>Playing your venues soon</h2></div><div class="chips">${sugg.map((a) => artistChip(a, mine.has(a.id))).join('')}</div>` : ''}`;
    foot = `<button class="btn primary big block" data-act="onb-next">${mine.size ? 'Continue' : 'Skip for now'}</button>`;
  } else if (step === 2) {
    const needsInstall = isIOS() && !isStandalone();
    body = `
      <div class="stack" style="gap:8px;margin:18px 0 18px"><h1>Only pings that matter</h1>
      <p class="muted">Presale Radar stays quiet unless it's useful:</p></div>
      <div class="stack" style="gap:16px">
        ${rule(I.zap, 'Right before a sale', '15 minutes before a presale for artists you follow, with the code ready.')}
        ${rule(I.moon, 'One evening roundup', "New shows and tomorrow's sales, in one message at 7 PM.")}
        ${rule(I.bellOff, 'Never overnight', 'Quiet from 10 PM to 8 AM, never the same thing twice.')}
      </div>
      <div class="section">${
        needsInstall
          ? `<div class="card stack"><h3>First, add it to your Home Screen</h3>
             <p class="muted small">On iPhone, notifications only work from the Home Screen app.</p>
             <div class="ios-steps small"><div>Tap ${I.share} Share in Safari</div><div>Choose ${I.squarePlus} Add to Home Screen</div><div>Open Presales from your Home Screen</div></div></div>`
          : !S.state.features.push
            ? `<div class="banner warn">${I.alert}<span>Push isn't set up on the server yet. Reminders still show in the app and calendar.</span></div>`
            : !pushSupported()
              ? `<div class="banner warn">${I.alert}<span>This browser can't receive notifications. Use the calendar instead.</span></div>`
              : ''
      }</div>`;
    const canPush = !needsInstall && S.state.features.push && pushSupported();
    foot = canPush
      ? `<button class="btn primary big block" data-act="enable-push" data-next="1">${I.bell} Turn on notifications</button><button class="btn ghost block" data-act="onb-skip-push">Not now</button>`
      : `<button class="btn primary big block" data-act="onb-next">Continue</button>`;
  } else {
    const cal = S.state.calendar;
    body = `
      <div class="stack" style="gap:8px;margin:18px 0 18px"><h1>Put sales in your calendar</h1>
      <p class="muted">Optional. Each sale becomes a calendar event that opens the sale screen, and it disappears when you hide the show or get tickets.</p></div>
      ${cal && cal.status === 'ok'
        ? `<div class="banner">${I.done}<span>Connected to iCloud. ${cal.events} sale${cal.events === 1 ? '' : 's'} added to your Presales calendar.</span></div>`
        : `<div class="card stack" style="gap:12px">
            <div class="row">${I.phone}<div class="grow"><b>iPhone Calendar</b><div class="small muted">Instant updates through iCloud</div></div><span class="pill good">Best</span></div>
            <button class="btn dark block" data-act="sheet" data-kind="icloud">Connect iPhone Calendar</button></div>
           <div class="card stack" style="gap:10px;margin-top:12px">
            <div class="row">${I.calendar}<div class="grow"><b>Other calendars</b><div class="small muted">Google, Outlook and others. Updates every few hours.</div></div></div>
            <div class="row"><a class="btn soft sm grow" href="${esc(S.state.calendarUrl.replace(/^https?/, 'webcal'))}">Subscribe</a><button class="btn soft sm grow" data-act="copy" data-text="${esc(S.state.calendarUrl)}">${I.copy} Copy link</button></div></div>`}`;
    foot = `<button class="btn primary big block" data-act="onb-finish">Done</button>`;
  }
  app.innerHTML = sheetHtml() + `<div class="onb">
      <div class="row between" style="min-height:40px">${step > 0 ? `<button class="icon-btn plain" data-act="onb-back" aria-label="Back">${I.back}</button>` : '<span></span>'}<div style="width:120px">${dots}</div></div>
      ${body}</div>
    <div class="onb-foot"><div class="inner">${foot}</div></div>`;
}

function rule(icon, title, text) {
  return `<div class="rule"><div class="ic">${icon}</div><div><b>${title}</b><div class="muted small">${text}</div></div></div>`;
}

function venueTile(v, on) {
  return `<button class="venue-tile ${on ? 'on' : ''}" data-act="toggle-venue" data-id="${esc(v.id)}" data-name="${esc(v.name)}" data-city="${esc(v.city ?? '')}">
    <span class="tick">${on ? I.check : ''}</span><span class="n">${esc(v.name)}</span><span class="c">${esc(v.city ?? '')}${v.upcoming ? ` · ${v.upcoming} shows` : ''}</span></button>`;
}

function artistChip(a, on) {
  return `<button class="chip ${on ? 'on' : ''}" data-act="toggle-artist" data-id="${esc(a.id)}" data-name="${esc(a.name)}">${on ? I.check : I.plus}${esc(a.name)}${a.shows ? `<span class="faint small">${a.shows}</span>` : ''}</button>`;
}

function artistRow(a, on) {
  return `<div class="item"><div class="grow"><div class="ellipsis"><b>${esc(a.name)}</b></div><div class="small muted">${esc(a.genre ?? '')}${a.upcoming ? ` · ${a.upcoming} upcoming` : ''}</div></div>
    <button class="btn sm ${on ? 'soft' : 'primary'}" data-act="toggle-artist" data-id="${esc(a.id)}" data-name="${esc(a.name)}" data-image="${esc(a.image ?? '')}">${on ? 'Following' : 'Follow'}</button></div>`;
}

async function loadPopular() {
  S.ui.popular = [];
  try {
    S.ui.popular = (await api('/api/venues/popular')).results;
  } catch (e) {
    toast(e.message);
  }
  render();
}

async function loadSuggested() {
  S.ui.suggested = [];
  try {
    S.ui.suggested = (await api('/api/artists/suggested')).results;
  } catch {}
  render();
}

// ============================================================ home (Sales)

function viewHome() {
  const sales = mySales();
  const deck = newAtVenues();
  const next = sales.find(({ sale }) => sale.startUtc - now() < 36 * HOUR);
  const rest = sales.filter((x) => x !== next);

  // Week strip: the next 14 days, with a dot on days that have sales.
  const days = Array.from({ length: 14 }, (_, i) => now() + i * DAY);
  const byDay = new Map();
  for (const x of rest) {
    const k = salePhase(x.sale) === 'open' ? dayKey(now()) : dayKey(x.sale.startUtc);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(x);
  }
  const keys = days.map(dayKey);
  if (!S.ui.day || !keys.includes(S.ui.day)) S.ui.day = keys.find((k) => byDay.has(k)) ?? keys[0];
  const selected = byDay.get(S.ui.day) ?? [];
  const nextDayWith = keys.find((k) => k > S.ui.day && byDay.has(k));
  const later = rest.filter((x) => !keys.includes(dayKey(x.sale.startUtc)) && salePhase(x.sale) !== 'open');
  const selMs = days[keys.indexOf(S.ui.day)];

  const strip = `<div class="week" role="tablist">${days
    .map((d, i) => {
      const k = keys[i];
      const n = byDay.get(k)?.length ?? 0;
      return `<button class="wday ${k === S.ui.day ? 'on' : ''} ${i === 0 ? 'today' : ''}" data-act="pick-day" data-k="${k}" role="tab" aria-label="${fmtDay(d)}, ${n} sales">
        <span class="wd">${i === 0 ? 'Today' : fmt(d, { weekday: 'short' })}</span><span class="dn">${fmt(d, { day: 'numeric' })}</span>
        <span class="dots">${n ? '<i></i>'.repeat(Math.min(3, n)) : ''}</span></button>`;
    })
    .join('')}</div>`;

  const dayList = selected.length
    ? `<div class="stack" style="gap:10px">${selected.map(saleCard).join('')}</div>`
    : `<div class="card row" style="justify-content:space-between"><span class="muted">Nothing on ${fmtDay(selMs).toLowerCase().startsWith('to') ? fmtDay(selMs).toLowerCase() : fmtDay(selMs)}</span>${
        nextDayWith ? `<button class="link-btn" data-act="pick-day" data-k="${nextDayWith}">Next: ${fmtDay(days[keys.indexOf(nextDayWith)])} ${I.chev}</button>` : ''
      }</div>`;

  const empty =
    !sales.length && !deck.length
      ? `<div class="empty"><div class="ic">${I.radar}</div><h2>All quiet</h2><p>No upcoming sales for your artists yet. New shows will appear here, and you'll get a heads-up.</p>
         <button class="btn" data-act="nav" data-href="#/shows">Browse shows at your venues</button></div>`
      : '';

  return `<div class="screen">
    <div class="topbar"><div class="title">Sales</div>${S.state.features.demo ? `<button class="btn sm soft" data-act="demo-tick">${I.refresh} Demo tick</button>` : ''}</div>
    ${pushNudge()}
    ${next ? heroCard(next) : ''}
    ${signupSection()}
    ${deck.length ? deckCard(deck) : ''}
    ${resaleDeals().length ? resaleSection(resaleDeals()) : ''}
    ${rest.length ? `<div class="section"><div class="section-head"><h2>Coming up</h2>${S.ui.day !== keys[0] ? `<button class="link-btn" data-act="pick-day" data-k="${keys[0]}">Today</button>` : ''}</div>${strip}<div style="margin-top:12px">${dayList}</div></div>` : ''}
    ${later.length ? `<div class="section">${
      S.ui.showLater
        ? `<div class="section-head"><h2>Later</h2><button class="link-btn" data-act="toggle-later">Hide</button></div><div class="stack" style="gap:10px">${later.map(saleCard).join('')}</div>`
        : `<button class="btn soft block" data-act="toggle-later">${later.length} more sale${later.length > 1 ? 's' : ''} after ${fmt(days[13], { month: 'short', day: 'numeric' })}</button>`
    }</div>` : ''}
    ${empty}
  </div>`;
}

/** "Tue 10 PM", "Today 9:30 PM": short enough to never get cut off. */
function shortWhen(ms) {
  const d = fmtDay(ms);
  const day = d === 'Today' || d === 'Tomorrow' ? d : fmt(ms, { weekday: 'short' });
  return `${day} ${fmtTime(ms).replace(':00', '')}`;
}

function openSignups(artistId) {
  return (S.state.signups ?? []).filter((n) => !n.done && n.at > now() && (!artistId || n.artistId === artistId));
}

function signupSection() {
  const list = openSignups().filter((n) => n.at - now() < 14 * DAY);
  if (!list.length) return '';
  return `<div class="section"><div class="section-head"><h2>Sign up before it closes</h2></div><div class="list">${list
    .map(
      (n) => `<div class="item"><div class="ic-dot">${I.flag}</div><div class="grow"><div class="ellipsis"><b>${esc(n.artist)}</b></div>
        <div class="small ellipsis" style="color:var(--warn);font-weight:600">Closes ${shortWhen(n.at)}</div>
        <div class="tiny faint ellipsis">${esc(n.label.replace(/^the /i, ''))}</div></div>
        <button class="icon-btn" data-act="signup-done" data-artist="${esc(n.artistId)}" data-label="${esc(n.label)}" data-at="${n.at}" aria-label="I'm signed up">${I.check}</button>
        <a class="btn sm primary" href="${esc(n.signupUrl ?? n.url)}" target="_blank" rel="noopener">Sign up</a></div>`,
    )
    .join('')}</div></div>`;
}

function signupBanner(artistId) {
  const n = openSignups(artistId)[0];
  if (!n) return '';
  return `<div class="banner warn" style="margin-top:14px">${I.flag}<div class="grow"><b>${esc(n.label.replace(/^the /i, ''))}: sign up by ${shortWhen(n.at)}</b>
    <div class="small muted">No sign-up, no code.</div>
    <div class="row" style="margin-top:8px"><a class="btn sm primary" href="${esc(n.signupUrl ?? n.url)}" target="_blank" rel="noopener">Sign up</a>
    <button class="btn sm ghost" data-act="signup-done" data-artist="${esc(n.artistId)}" data-label="${esc(n.label)}" data-at="${n.at}">I'm signed up</button></div></div></div>`;
}

function deckCard(list) {
  const venues = [...new Set(list.map((s) => s.venue).filter(Boolean))];
  return `<div class="section"><div class="card tap deck-entry" data-act="nav" data-href="#/review">
    <div class="stack-preview">${list.slice(0, 3).map((s, i) => `<span style="--i:${i}">${esc(s.artist.slice(0, 1))}</span>`).join('')}</div>
    <div class="grow"><b>${list.length} new show${list.length > 1 ? 's' : ''} at your venues</b><div class="small muted ellipsis">${esc(venues.slice(0, 3).join(', '))}</div></div>
    <span class="btn sm primary">Review</span></div></div>`;
}

// ============================================================ review deck (swipe)

function viewReview() {
  if (!S.ui.deck) S.ui.deck = { ids: newAtVenues().map((s) => s.id), i: 0, history: [], tally: { remind: 0, pass: 0, maybe: 0 } };
  const d = S.ui.deck;
  const total = d.ids.length;
  if (d.i >= total) {
    const t = d.tally;
    return `<div class="screen no-tabs"><div class="center" style="flex-direction:column;gap:16px;text-align:center">
      <div class="logo" style="background:var(--good)">${I.check}</div><h1>All caught up</h1>
      <p class="muted">${[t.remind && `${t.remind} with reminders`, t.maybe && `${t.maybe} kept for later`, t.pass && `${t.pass} passed`].filter(Boolean).join(' · ') || 'Nothing new right now.'}</p>
      <button class="btn primary big" style="min-width:200px" data-act="deck-done">Done</button>
      ${d.history.length ? `<button class="link-btn" data-act="deck-undo">Undo last</button>` : ''}</div></div>`;
  }
  const s = findShow(d.ids[d.i]);
  if (!s) {
    d.i++;
    return viewReview();
  }
  const n = s.sales.filter((x) => x.startUtc && x.startUtc > now()).sort((a, b) => a.startUtc - b.startUtc)[0];
  const price = s.priceMin ? `From $${Math.round(s.priceMin)}` : '';
  const peek = d.ids[d.i + 1] ? findShow(d.ids[d.i + 1]) : null;
  return `<div class="screen no-tabs deck-screen">
    <div class="topbar"><button class="icon-btn" data-act="deck-close" aria-label="Close">${I.x}</button>
      <div class="small muted">${d.i + 1} of ${total}</div>
      ${d.history.length ? `<button class="link-btn" data-act="deck-undo">Undo</button>` : '<span style="width:40px"></span>'}</div>
    <div class="deck-progress"><span style="width:${(d.i / total) * 100}%"></span></div>
    <div class="deck">
      ${peek ? `<div class="deck-card peek"><div class="art-fallback">${esc(peek.artist.slice(0, 1))}</div></div>` : ''}
      <div class="deck-card" data-deck="${esc(s.id)}">
        <div class="stamp yes">REMIND</div><div class="stamp no">PASS</div>
        ${s.image ? `<img class="art" src="${esc(s.image)}" alt="">` : `<div class="art-fallback" style="--h:${[...s.artist].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}"><span>${esc(s.artist.split(/\s+/).slice(0, 2).map((w) => w[0]).join(''))}</span></div>`}
        <div class="deck-body">
          <div class="small" style="color:var(--accent-text);font-weight:600">${esc(s.venue ?? '')}</div>
          <h1 style="margin:2px 0 4px">${esc(s.artist)}</h1>
          <div class="muted">${fmtLocalDate(s.date, { weekday: 'long', month: 'long', day: 'numeric' })}${price ? ` · ${price}` : ''}</div>
          ${n ? `<div class="row small" style="margin-top:12px;gap:8px"><span class="pill accent">${n.kind === 'public' ? 'On sale' : esc(n.name)}</span><span class="muted">${fmtDay(n.startUtc)}, ${fmtTime(n.startUtc)}</span></div>` : s.source === 'seatgeek' ? '<div class="small muted" style="margin-top:12px">Sold outside Ticketmaster</div>' : ''}
        </div>
      </div>
    </div>
    <div class="deck-actions">
      <button class="round no" data-act="deck" data-v="pass" aria-label="Not for me">${I.x}</button>
      <button class="round maybe" data-act="deck" data-v="maybe" aria-label="Maybe later">Maybe</button>
      <button class="round yes" data-act="deck" data-v="remind" aria-label="Remind me">${I.bell}</button>
    </div>
    <p class="tiny faint" style="text-align:center;margin-top:12px">Swipe right for reminders, left to pass</p>
    ${s.artistId ? `<p style="text-align:center;margin-top:2px"><button class="link-btn" style="font-size:13px;color:var(--text-3);font-weight:500" data-act="deck" data-v="mute">Never show ${esc(s.artist)}</button></p>` : ''}
  </div>`;
}

async function deckDecide(v) {
  const d = S.ui.deck;
  const id = d.ids[d.i];
  const s = findShow(id);
  if (!id) return;
  const card = document.querySelector('[data-deck]');
  if (card) {
    card.style.transition = 'transform .25s ease, opacity .25s ease';
    card.style.transform = v === 'remind' ? 'translateX(120%) rotate(12deg)' : v === 'maybe' ? 'translateY(-30px) scale(.95)' : 'translateX(-120%) rotate(-12deg)';
    card.style.opacity = '0';
  }
  d.history.push({ id, v, artistId: s?.artistId });
  if (v === 'mute') d.tally.pass++;
  else d.tally[v]++;
  d.i++;
  const body = v === 'remind' ? { state: 'tracked', seen: true } : v === 'maybe' ? { seen: true } : { state: 'dismissed', seen: true };
  const req = v === 'mute' ? api('/api/mute-artist', { body: { id: s.artistId, name: s.artist } }) : api(`/api/shows/${encodeURIComponent(id)}`, { body });
  setTimeout(render, 200);
  try {
    await req;
    if (v === 'mute') {
      // Skip this artist's other new shows in the deck.
      d.ids = d.ids.filter((x, k) => k < d.i || findShow(x)?.artistId !== s.artistId);
    }
    loadState().then(() => S.route.name === 'review' || render());
  } catch (e) {
    toast(e.message);
  }
}

async function deckUndo() {
  const d = S.ui.deck;
  const last = d.history.pop();
  if (!last) return;
  d.i = Math.max(0, d.ids.indexOf(last.id));
  if (last.v === 'mute') d.tally.pass--;
  else d.tally[last.v]--;
  if (last.v === 'mute') await api(`/api/artists/${encodeURIComponent(last.artistId)}`, { method: 'DELETE' }).catch(() => {});
  await api(`/api/shows/${encodeURIComponent(last.id)}`, { body: { state: 'auto', seen: false } }).catch(() => {});
  await loadState();
  render();
}

function bindDeck() {
  const card = document.querySelector('[data-deck]');
  if (!card) return;
  let x0 = null;
  let y0 = null;
  let dx = 0;
  card.addEventListener('pointerdown', (e) => {
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    const dy = (e.clientY - y0) * 0.2;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    card.querySelector('.stamp.yes').style.opacity = Math.max(0, Math.min(1, dx / 90));
    card.querySelector('.stamp.no').style.opacity = Math.max(0, Math.min(1, -dx / 90));
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    if (dx > 100) return deckDecide('remind');
    if (dx < -100) return deckDecide('pass');
    card.style.transition = 'transform .2s ease';
    card.style.transform = '';
    card.querySelectorAll('.stamp').forEach((el) => (el.style.opacity = 0));
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

// ============================================================ sign-in-free sale link (from calendar)

async function renderLink() {
  const { u, saleId, sig } = S.route.params;
  if (S.auth?.signedIn && S.state?.me?.id === u) {
    location.replace(`#/go/${encodeURIComponent(saleId)}`);
    return;
  }
  if (!S.guest || S.guest.saleId !== saleId) {
    app.innerHTML = `<div class="center"><div class="spinner"></div></div>`;
    try {
      S.guest = await api(`/api/link/${u}/${encodeURIComponent(saleId)}/${sig}`);
    } catch (e) {
      app.innerHTML = `<div class="welcome"><div class="logo">${I.radar}</div><h1>Link expired</h1><p class="muted">${esc(e.message)}</p><a class="btn block" href="/">Open Presale Radar</a></div>`;
      return;
    }
  }
  app.innerHTML = viewGo(saleId);
  afterRender();
}

function pushNudge() {
  const f = S.state.features;
  if (!f.push || f.pushDevices > 0 || !pushSupported() || localStorage.getItem('nudge-push') === 'no') return '';
  if (isIOS() && !isStandalone()) return '';
  return `<div class="banner" style="margin-bottom:12px">${I.bell}<div class="grow">Get a ping 15 minutes before your sales.<div class="row" style="margin-top:8px"><button class="btn sm primary" data-act="enable-push">Turn on</button><button class="btn sm ghost" data-act="nudge-no">Not now</button></div></div></div>`;
}

function heroCard({ show, sale }) {
  const phase = salePhase(sale);
  const status =
    phase === 'open'
      ? `<span class="status-line"><span class="live-dot"></span>&nbsp; Open now</span>`
      : `<span class="status-line muted">${fmtDay(sale.startUtc)} at ${fmtTime(sale.startUtc)}</span>`;
  return `<div class="card hero tap stack" style="gap:12px" data-act="nav" data-href="#/go/${encodeURIComponent(sale.id)}">
    <div class="row between"><span class="pill accent">${sale.kind === 'public' ? 'Public on-sale' : esc(sale.name)}</span>${status}</div>
    <div><div style="font-size:24px;font-weight:700;letter-spacing:-0.02em">${esc(show.artist)}</div><div class="muted small">${esc(show.venue ?? '')} · ${fmtLocalDate(show.date)}</div></div>
    ${phase === 'open' ? '' : `<div class="countdown" data-countdown="${sale.startUtc}">${countdownParts(sale.startUtc)}</div>`}
    ${accessLine(sale)}
    <button class="btn ${phase === 'prep' ? 'dark' : 'primary'} block">${phase === 'prep' ? 'Get ready' : phase === 'soon' ? 'Join the waiting room' : 'Go to sale'} ${I.chev}</button>
  </div>`;
}

/** Watched shows where resale is at or under your target right now. */
function resaleDeals() {
  if (!S.state.features.seatgeek) return [];
  return shows()
    .filter((s) => s.resale?.watching && s.resale.low != null && s.resale.target != null && s.resale.low <= s.resale.target)
    .sort((a, b) => (a.startUtc ?? 0) - (b.startUtc ?? 0));
}

function resaleSection(list) {
  return `<div class="section"><div class="section-head"><h2>Resale at or under your price</h2></div>
    <div class="list">${list
      .map(
        (s) => `<div class="item tap" data-act="nav" data-href="#/show/${encodeURIComponent(s.id)}">
        <div class="date-block"><div class="m">${fmtLocalDate(s.date, { month: 'short' })}</div><div class="d">${fmtLocalDate(s.date, { day: 'numeric' })}</div></div>
        <div class="grow"><div class="ellipsis"><b>${esc(s.artist)}</b></div><div class="small muted ellipsis">${esc(s.venue ?? '')} · ${s.resale.count ?? '?'} listings</div></div>
        <div style="text-align:right"><div style="font-weight:700;font-size:17px;color:var(--good)">$${Math.round(s.resale.low)}</div><div class="tiny faint">your max $${Math.round(s.resale.target)}</div></div></div>`,
      )
      .join('')}</div></div>`;
}

function resaleCard(s) {
  const r = s.resale;
  if (!r || !S.state.features.seatgeek) return '';
  const under = r.low != null && s.priceMin && r.low <= s.priceMin;
  const priceLine =
    r.low == null || !r.count
      ? '<div class="muted">No resale listings right now</div>'
      : `<div class="row" style="gap:8px;align-items:baseline"><span style="font-size:28px;font-weight:750;letter-spacing:-0.02em">$${Math.round(r.low)}</span><span class="muted small">lowest · ${r.count} listing${r.count === 1 ? '' : 's'}</span>${under ? '<span class="pill good">Under face</span>' : ''}</div>`;
  const autoNote = r.explicit === null ? (r.watching ? 'On automatically because this show is on sale and you get reminders for it.' : 'Turn on to get a ping when the price drops.') : '';
  return `<div class="section"><div class="section-head"><h2>Resale</h2>${r.checkedAt ? `<span class="tiny faint">Checked ${ago(r.checkedAt)}</span>` : ''}</div>
    <div class="card stack" style="gap:12px">
      ${priceLine}
      ${s.priceMin ? `<div class="small muted">Face value from $${Math.round(s.priceMin)}${s.priceMax && s.priceMax !== s.priceMin ? ` to $${Math.round(s.priceMax)}` : ''}</div>` : ''}
      <hr class="sep" style="margin:0">
      <div class="row"><div class="grow"><b style="font-weight:600">Ping me when it drops to</b><div class="tiny faint">${autoNote}</div></div>
        <input type="checkbox" class="switch" data-act="resale-watch" data-id="${esc(s.id)}" ${r.watching ? 'checked' : ''}></div>
      ${r.watching ? `<div class="row"><span class="muted">$</span><input class="input" style="width:110px;min-height:42px" type="number" inputmode="numeric" min="1" step="1" data-resale-target="${esc(s.id)}" value="${r.target != null ? Math.round(r.target) : ''}" placeholder="Price"><span class="small faint grow">${r.customTarget == null && s.priceMin ? 'Defaults to face value' : ''}</span></div>` : ''}
      ${r.url ? `<a class="btn soft block" href="${esc(r.url)}" target="_blank" rel="noopener">See listings on SeatGeek ${I.external}</a>` : ''}
      <p class="tiny faint">SeatGeek shows only the cheapest price, often a single seat. In Ontario, resale can't go above what the seller paid.</p>
    </div></div>`;
}

function triageSection(list) {
  const shown = list.slice(0, 4);
  return `<div class="section"><div class="section-head"><h2>New at your venues</h2><button class="link-btn" data-act="seen-all">Clear</button></div>
    <p class="tiny faint" style="margin:-4px 4px 10px">Tap the bell for reminders, or ✕ to pass.</p>
    <div class="list triage">${shown
      .map(
        (s) => `<div class="item">
        <div class="date-block">${s.date ? `<div class="m">${fmtLocalDate(s.date, { month: 'short' })}</div><div class="d">${fmtLocalDate(s.date, { day: 'numeric' })}</div>` : '<div class="m">TBA</div>'}</div>
        <div class="grow tap" data-act="nav" data-href="#/show/${encodeURIComponent(s.id)}"><div class="ellipsis"><b>${esc(s.artist)}</b></div><div class="small muted ellipsis">${esc(s.venue ?? '')}${nextSaleText(s)}</div></div>
        <div class="actions"><button class="icon-btn" data-act="hide-show" data-id="${esc(s.id)}" aria-label="Not interested">${I.x}</button><button class="icon-btn" style="background:var(--accent);color:#fff" data-act="star" data-id="${esc(s.id)}" aria-label="Remind me">${I.bell}</button></div>
      </div>`,
      )
      .join('')}
      ${list.length > shown.length ? `<div class="item tap" data-act="nav" data-href="#/shows" style="justify-content:center"><span class="link-btn">See all ${list.length}</span></div>` : ''}
    </div></div>`;
}

function nextSaleText(show) {
  const n = show.sales.filter((x) => x.startUtc && x.startUtc > now()).sort((a, b) => a.startUtc - b.startUtc)[0];
  return n ? ` · ${n.kind === 'public' ? 'On sale' : 'Presale'} ${fmtDay(n.startUtc).toLowerCase().replace(/^(mon|tue|wed|thu|fri|sat|sun)/, (m) => m[0].toUpperCase() + m.slice(1))}` : '';
}

function saleCard({ show, sale, later = [] }) {
  const phase = salePhase(sale);
  const time = fmtTime(sale.startUtc).split(' ');
  return `<div class="swipe-wrap" data-swipe="${esc(show.id)}"><div class="behind">${I.eyeOff} Hide show</div>
    <div class="card tap" data-act="nav" data-href="#/go/${encodeURIComponent(sale.id)}"><div class="sale">
      <div class="when"><div class="t">${time[0]}</div><div class="ap">${time[1] ?? ''}</div></div>
      <div class="grow"><div class="row between"><span class="pill ${phase === 'open' ? 'good' : ''}">${phase === 'open' ? 'Open now' : sale.kind === 'public' ? 'On-sale' : esc(sale.name)}</span>${show.isNew ? '<span class="pill new">New</span>' : ''}</div>
        <div class="who ellipsis" style="margin-top:6px">${esc(show.artist)}</div>
        <div class="meta ellipsis">${esc(show.venue ?? '')} · ${fmtLocalDate(show.date)}</div>
        ${accessLine(sale, { compact: true })}
        ${later.length ? `<div class="tiny faint" style="margin-top:6px">Then ${later.slice(0, 2).map((l) => `${l.kind === 'public' ? 'on-sale' : esc(l.name)} ${fmtDay(l.startUtc).toLowerCase().startsWith('to') ? fmtDay(l.startUtc).toLowerCase() : fmtDay(l.startUtc)}`).join(', ')}</div>` : ''}</div>
    </div></div></div>`;
}

// ---- swipe to hide

function bindSwipes() {
  document.querySelectorAll('[data-swipe]').forEach((wrap) => {
    const card = wrap.querySelector('.card');
    let x0 = null;
    let y0 = null;
    let dx = 0;
    let swiping = false;
    card.addEventListener('pointerdown', (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      swiping = false;
    });
    card.addEventListener('pointermove', (e) => {
      if (x0 === null) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!swiping && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5) {
        swiping = true;
        card.setPointerCapture(e.pointerId);
        card.style.transition = 'none';
      }
      if (swiping) {
        dx = Math.min(0, mx);
        card.style.transform = `translateX(${dx}px)`;
      }
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      card.style.transition = '';
      if (swiping && dx < -100) {
        card.style.transform = 'translateX(-110%)';
        card.dataset.swiped = '1';
        setTimeout(() => hideShow(wrap.dataset.swipe), 180);
      } else card.style.transform = '';
      if (swiping) card.dataset.justSwiped = '1';
      setTimeout(() => delete card.dataset.justSwiped, 50);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  });
}

// ============================================================ shows

function viewShows() {
  const f = S.ui.showsFilter;
  const q = S.ui.showsQuery.trim().toLowerCase();
  let list = shows().filter((s) => (f === 'got' ? s.gotTickets : f === 'remind' ? s.level === 'remind' && !s.gotTickets : s.level === 'feed' && !s.gotTickets));
  if (q) list = list.filter((s) => `${s.artist} ${s.venue} ${s.name}`.toLowerCase().includes(q));
  const months = new Map();
  for (const s of list) {
    const key = s.date ? fmtLocalDate(s.date, { month: 'long', year: 'numeric' }) : 'Date TBA';
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(s);
  }
  const counts = {
    remind: shows().filter((s) => s.level === 'remind' && !s.gotTickets).length,
    feed: shows().filter((s) => s.level === 'feed' && !s.gotTickets).length,
    got: shows().filter((s) => s.gotTickets).length,
  };
  const emptyText = {
    remind: 'Shows by artists you follow, and ones you tapped "Remind me" on, will show up here.',
    feed: 'Shows at your venues appear here. Follow venues in Settings.',
    got: 'Mark "Got tickets" on a show and it lands here. Reminders for it stop.',
  }[f];
  return `<div class="screen">
    <div class="topbar"><div class="title">Shows</div></div>
    <div class="seg" style="margin-bottom:12px">
      <button class="${f === 'remind' ? 'on' : ''}" data-act="shows-filter" data-v="remind">For you ${counts.remind ? `· ${counts.remind}` : ''}</button>
      <button class="${f === 'feed' ? 'on' : ''}" data-act="shows-filter" data-v="feed">Your venues ${counts.feed ? `· ${counts.feed}` : ''}</button>
      <button class="${f === 'got' ? 'on' : ''}" data-act="shows-filter" data-v="got">Going ${counts.got ? `· ${counts.got}` : ''}</button>
    </div>
    <div class="search">${I.search}<input class="input" data-search="shows" placeholder="Filter by artist or venue" value="${esc(S.ui.showsQuery)}"></div>
    ${
      list.length
        ? [...months.entries()]
            .map(([m, l]) => `<div class="section"><div class="section-head"><h2>${esc(m)}</h2></div><div class="list">${l.map(showRow).join('')}</div></div>`)
            .join('')
        : `<div class="empty"><div class="ic">${I.music}</div><p>${q ? 'Nothing matches that.' : emptyText}</p></div>`
    }
  </div>`;
}

function showRow(s) {
  const badge =
    s.status === 'canceled'
      ? '<span class="pill bad">Cancelled</span>'
      : s.status === 'postponed'
        ? '<span class="pill warn">Postponed</span>'
        : s.availability === 'TICKETS_NOT_AVAILABLE'
          ? '<span class="pill">Sold out</span>'
          : s.isNew
            ? '<span class="pill new">New</span>'
            : '';
  const right =
    s.level === 'feed'
      ? `<button class="icon-btn" data-act="star" data-id="${esc(s.id)}" aria-label="Remind me">${I.bell}</button>`
      : s.starred
        ? `<span style="color:var(--accent-text)">${I.starFill}</span>`
        : `<span class="chev">${I.chev}</span>`;
  return `<div class="item tap" data-act="nav" data-href="#/show/${encodeURIComponent(s.id)}">
    <div class="date-block">${s.date ? `<div class="m">${fmtLocalDate(s.date, { weekday: 'short' })}</div><div class="d">${fmtLocalDate(s.date, { day: 'numeric' })}</div>` : '<div class="m">TBA</div>'}</div>
    <div class="grow"><div class="row" style="gap:6px"><b class="ellipsis">${esc(s.artist)}</b>${badge}</div><div class="small muted ellipsis">${esc(s.venue ?? '')}${s.source === 'seatgeek' ? ' · via SeatGeek' : s.source === 'web' ? ` · venue site${nextSaleText(s)}` : nextSaleText(s)}${s.resale?.watching && s.resale.low != null ? ` · resale $${Math.round(s.resale.low)}` : ''}</div></div>
    ${right}</div>`;
}

// ============================================================ show detail

function viewShow(id) {
  const s = findShow(id);
  if (!s) return `<div class="screen no-tabs">${backBar()}<div class="empty"><p>This show isn't in your list anymore.</p></div></div>`;
  if (s.isNew) {
    s.isNew = false;
    api(`/api/shows/${encodeURIComponent(s.id)}`, { body: { seen: true } }).catch(() => {});
  }
  const hidden = S.state.hidden.some((h) => h.id === s.id);
  const reasonText = {
    starred: "You asked for reminders on this show.",
    artist: `You follow ${esc(s.artist)}, so you'll get reminders.`,
    venue_all: `You get reminders for every show at ${esc(s.venue)}.`,
    venue: `It's at ${esc(s.venue)}. Tap "Remind me" to get reminders.`,
    hidden: 'You hid this show.',
    muted: `You muted ${esc(s.artist)}.`,
  }[s.reason] ?? '';
  const sales = s.sales.filter((x) => x.startUtc ? saleOpenUntil(x) > now() : true);
  const past = s.sales.filter((x) => x.startUtc && saleOpenUntil(x) <= now());
  const price = s.priceMin ? `$${Math.round(s.priceMin)}${s.priceMax && s.priceMax !== s.priceMin ? `–$${Math.round(s.priceMax)}` : ''}` : '';
  const statusPill =
    s.status === 'canceled' ? '<span class="pill bad">Cancelled</span>'
    : s.status === 'postponed' ? '<span class="pill warn">Postponed</span>'
    : s.status === 'rescheduled' ? '<span class="pill warn">Rescheduled</span>'
    : s.availability === 'TICKETS_NOT_AVAILABLE' ? '<span class="pill">Sold out</span>'
    : s.availability === 'FEW_TICKETS_LEFT' ? '<span class="pill warn">Few left</span>' : '';

  return `<div class="screen no-tabs">
    ${backBar(s.url ? `<a class="icon-btn" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="Open on Ticketmaster">${I.external}</a>` : '')}
    <div class="show-head">
      ${s.image ? `<img class="art" src="${esc(s.image)}" alt="" loading="lazy">` : ''}
      <div class="row wrap" style="gap:6px;margin-bottom:6px">${statusPill}${s.gotTickets ? '<span class="pill good">Got tickets</span>' : ''}</div>
      <h1>${esc(s.artist)}</h1>
      ${s.name !== s.artist ? `<div class="muted">${esc(s.name)}</div>` : ''}
      <div class="muted" style="margin-top:6px">${esc(s.venue ?? '')} · ${fmtLocalDate(s.date, { weekday: 'long', month: 'long', day: 'numeric' })}${s.startUtc ? `, ${fmtTime(s.startUtc)}` : ''}${price ? ` · ${price}` : ''}</div>
      <p class="small faint" style="margin-top:8px">${reasonText}</p>
    </div>
    <div class="action-row">
      ${hidden
        ? `<button class="action on" data-act="unhide-show" data-id="${esc(s.id)}">${I.eyeOff}Unhide</button>`
        : `<button class="action ${s.level === 'remind' ? 'on' : ''}" data-act="${s.starred ? 'unstar' : s.level === 'remind' ? 'why-reminding' : 'star'}" data-id="${esc(s.id)}" data-reason="${esc(s.reason)}" data-artist="${esc(s.artist)}" data-venue="${esc(s.venue ?? '')}">${s.level === 'remind' ? I.bell : I.bell}${s.level === 'remind' ? 'Reminding' : 'Remind me'}</button>`}
      <button class="action ${s.gotTickets ? 'on good' : ''}" data-act="got" data-id="${esc(s.id)}">${I.done}${s.gotTickets ? 'Going' : 'Got tickets'}</button>
      <button class="action" data-act="hide-show" data-id="${esc(s.id)}" data-back="1">${I.eyeOff}Hide</button>
      ${s.artistId ? `<button class="action" data-act="mute" data-id="${esc(s.artistId)}" data-name="${esc(s.artist)}">${I.mute}Mute artist</button>` : '<span></span>'}
    </div>
    ${s.availability === 'TICKETS_NOT_AVAILABLE' && !s.gotTickets && S.state.features.soldOutWatch
      ? `<div class="card row" style="margin-top:14px">${I.radar}<div class="grow"><b>Sold-out watch</b><div class="small muted">Urgent ping if seats are released</div></div><input type="checkbox" class="switch" data-act="watch" data-id="${esc(s.id)}" ${s.watchSoldout ? 'checked' : ''}></div>` : ''}
    ${s.artistId ? signupBanner(s.artistId) : ''}
    ${resaleCard(s)}
    ${s.source === 'seatgeek' || s.source === 'web'
      ? `<div class="section"><div class="banner">${I.info}<span>${s.source === 'web' ? "Found on the venue's website, not Ticketmaster." : 'Not sold on Ticketmaster. Found through SeatGeek.'} ${s.sales.length ? '' : 'There are no presale times, so check the venue for tickets.'}</span></div></div>`
      : `<div class="section"><div class="section-head"><h2>Sales</h2></div>
      <div class="card">${sales.length ? sales.map((x) => saleBlock(s, x)).join('') : '<p class="muted">No upcoming sales. Tickets may already be on sale.</p>'}</div>
      ${past.length ? `<p class="faint small" style="margin:10px 4px">Ended: ${past.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    </div>`}
    ${s.url ? `<div class="section"><a class="btn dark big block" href="${esc(s.url)}" target="_blank" rel="noopener">${s.source === 'ticketmaster' ? 'Open on Ticketmaster' : s.source === 'web' ? 'Open venue page' : 'Open on SeatGeek'} ${I.external}</a></div>` : ''}
  </div>`;
}

function backBar(right = '') {
  return `<div class="topbar"><button class="icon-btn" data-act="back" aria-label="Back">${I.back}</button>${right}</div>`;
}

function saleBlock(show, sale) {
  const phase = sale.startUtc ? salePhase(sale) : 'tba';
  const when = sale.startTbd || !sale.startUtc ? 'Date TBA' : phase === 'open' ? 'Open now' : `${fmtDay(sale.startUtc)}, ${fmtTime(sale.startUtc)}`;
  return `<div class="sale-block">
    <div class="row between"><b>${esc(sale.name)}</b><span class="small ${phase === 'open' ? '' : 'muted'}" style="${phase === 'open' ? 'color:var(--good);font-weight:600' : ''}">${when}</span></div>
    ${accessLine(sale)}
    ${sale.startUtc && show.level === 'remind' && !show.gotTickets ? `<button class="btn sm soft" style="margin-top:10px" data-act="nav" data-href="#/go/${encodeURIComponent(sale.id)}">Open sale screen ${I.chev}</button>` : ''}
  </div>`;
}

// ============================================================ sale-day screen

function viewGo(saleId) {
  const found = findSale(saleId);
  if (!found) return `<div class="screen no-tabs">${backBar()}<div class="empty"><p>This sale isn't listed anymore. Ticketmaster may have removed it.</p></div></div>`;
  const { show, sale } = found;
  const phase = salePhase(sale);
  const codes = sale.codes ?? [];
  const best = codes[0];
  const checklist = checklistItems(sale, best);
  const done = loadChecks(sale.id);
  const allDone = checklist.every((c) => done.has(c.id) || c.auto);
  const nextSale = show.sales.filter((x) => x.id !== sale.id && x.startUtc && x.startUtc > now()).sort((a, b) => a.startUtc - b.startUtc)[0];
  const launch = !(S.ui.launchOff ?? []).includes(sale.id) && phase !== 'over' && (phase === 'open' || sale.startUtc - now() <= 15 * MIN);
  if (launch) return launchView(show, sale, codes);

  const headline =
    phase === 'open'
      ? `<div class="status-line" style="font-size:18px"><span class="live-dot"></span>&nbsp; It's open. Go!</div>`
      : phase === 'over'
        ? `<div class="status-line muted">This sale has ended</div>`
        : `<div class="countdown" data-countdown="${sale.startUtc}">${countdownParts(sale.startUtc)}</div><div class="muted small" style="margin-top:6px">${fmtDay(sale.startUtc)} at ${fmtTime(sale.startUtc)}</div>`;

  const cta =
    phase === 'over'
      ? ''
      : `<button class="btn ${phase === 'prep' ? 'dark' : 'primary'} big block" data-act="buy" data-sale="${esc(sale.id)}">
           ${best ? `${I.copy} Copy code and open Ticketmaster` : `Open Ticketmaster ${I.external}`}</button>
         <p class="small muted" style="text-align:center">${
           phase === 'prep'
             ? 'The waiting room usually opens 10 to 30 minutes before.'
             : phase === 'soon'
               ? 'Join the waiting room now. Your spot is random, not first come.'
               : best
                 ? 'Paste the code when Ticketmaster asks for it.'
                 : 'Head straight in.'
         }</p>`;

  const top = S.guest && S.route.name === 'link'
    ? `<div class="topbar"><div class="row small muted" style="gap:8px"><span class="logo" style="width:28px;height:28px;border-radius:8px">${I.radar}</span>Presale Radar</div><a class="btn sm soft" href="/">Open app</a></div>`
    : backBar(`<button class="btn sm soft" data-act="nav" data-href="#/show/${encodeURIComponent(show.id)}">Show details</button>`);
  return `<div class="screen no-tabs">
    ${top}
    <div class="stack" style="gap:4px;margin:6px 0 18px">
      <span class="pill accent" style="align-self:flex-start">${sale.kind === 'public' ? 'Public on-sale' : esc(sale.name)}</span>
      <h1 style="margin-top:6px">${esc(show.artist)}</h1>
      <div class="muted">${esc(show.venue ?? '')} · ${fmtLocalDate(show.date)}</div>
    </div>
    ${S.state && show.artistId && phase === 'prep' ? signupBanner(show.artistId) : ''}
    <div class="card stack" style="gap:16px;padding:20px${S.state && show.artistId && phase === 'prep' && openSignups(show.artistId).length ? ';margin-top:14px' : ''}">
      <div>${headline}</div>
      ${phase === 'over' && !codes.length ? '' : codeSection(sale, codes)}
      ${cta}
    </div>
    ${
      phase === 'over' || phase === 'open'
        ? afterSale(show, nextSale)
        : `<div class="section"><div class="section-head"><h2>Before it starts</h2>${allDone ? '<span class="pill good">Ready</span>' : ''}</div>
           <div class="card" style="padding:4px 16px">${checklist
             .map(
               (c) => `<div class="check ${done.has(c.id) || c.auto ? 'done' : ''}" data-act="check" data-sale="${esc(sale.id)}" data-id="${c.id}">
                <div class="box">${done.has(c.id) || c.auto ? I.check : ''}</div><div class="grow"><div class="label">${c.label}</div>${c.hint ? `<div class="small faint">${c.hint}</div>` : ''}</div></div>`,
             )
             .join('')}</div></div>
           <div class="section"><div class="section-head"><h2>Tips</h2></div><div class="card small muted stack" style="gap:8px">
             <div>• Use one device and one tab. Several can get you flagged.</div>
             <div>• Don't refresh in the queue. It can lose your place.</div>
             <div>• Grab good-enough seats fast. Carts expire and the best rarely come back.</div>
           </div></div>`
    }
  </div>`;
}

function launchView(show, sale, codes) {
  const open = salePhase(sale) === 'open';
  const best = codes[0];
  const label = sale.kind === 'public' ? 'Public on-sale' : sale.name;
  return `<div class="launch" data-launch>
    <div class="launch-top"><button class="icon-btn" style="background:rgba(0,0,0,.18);color:#fff" data-act="launch-exit" data-sale="${esc(sale.id)}" aria-label="Exit launch mode">${I.x}</button>
      <div class="launch-title"><div>${esc(show.artist)}</div><span>${esc(label)}</span></div><span style="width:40px"></span></div>
    <div class="launch-mid">
      ${open
        ? `<div class="launch-state"><span class="live-dot" style="background:#fff;box-shadow:0 0 0 4px rgba(255,255,255,.3)"></span> It's open</div><div class="launch-sub">Go now. Paste the code when asked.</div>`
        : `<div class="launch-count" data-countdown="${sale.startUtc}">${countdownParts(sale.startUtc)}</div><div class="launch-sub">Join the waiting room now. Your spot is random, not first come.</div>`}
      ${best
        ? `<button class="launch-code" data-act="copy" data-text="${esc(best.code)}"><span class="tiny">Tap to copy code</span><b>${esc(best.code)}</b></button>
           ${codes.length > 1 ? `<div class="launch-alts">${codes.slice(1, 4).map((c) => `<button data-act="copy" data-text="${esc(c.code)}">${esc(c.code)}</button>`).join('')}</div>` : ''}`
        : sale.kind === 'public' ? '' : `<div class="launch-sub" style="opacity:.9">${sale.requirement === 'card' ? 'No code needed. Use the eligible card.' : sale.requirement === 'register' ? 'Use the link or code from your registration email.' : 'No code found. Check your email.'}</div>`}
    </div>
    <button class="launch-go" data-act="buy" data-sale="${esc(sale.id)}">${best ? 'Copy code and open Ticketmaster' : 'Open Ticketmaster'} ${I.external}</button>
    <div class="launch-foot">Screen stays awake · Use one tab · Don't refresh in the queue</div>
  </div>`;
}

function codeSection(sale, codes) {
  if (sale.kind === 'public') return '';
  const guest = !!S.guest && S.route.name === 'link';
  const editing = S.ui.codeEdit === sale.id;
  const form = `<form class="stack" style="gap:8px" data-form="code" data-sale="${esc(sale.id)}">
      <input class="input mono" name="code" placeholder="Paste your code" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(codes[0]?.source === 'you' ? codes[0].code : '')}">
      <label class="row small muted"><input type="checkbox" name="remember" checked> Use it for this artist's other dates too</label>
      <div class="row"><button class="btn primary sm" type="submit">Save code</button><button class="btn ghost sm" type="button" data-act="code-cancel">Cancel</button></div>
      <div class="error"></div></form>`;
  if (!codes.length) {
    const msg = {
      card: 'No code needed. Pay with the eligible card.',
      register: 'Registration required. If you signed up, your code or link comes by email or text.',
      code: "No code found yet. We're searching and will ping you if one turns up.",
    }[sale.requirement] ?? 'Check your email for a code, or head in and see.';
    return `<div class="stack" style="gap:10px"><div class="row small muted" style="gap:8px">${I.key}<span>${msg}</span></div>
      ${guest ? '' : editing ? form : `<button class="link-btn" style="align-self:flex-start" data-act="code-edit" data-sale="${esc(sale.id)}">${I.plus} Add a code</button>`}</div>`;
  }
  const best = codes[0];
  const src = {
    you: 'Your code',
    saved: 'Saved for this artist',
    ticketmaster: "From Ticketmaster's listing",
    livenation: 'Official Live Nation password',
    web: `Found online · ${best.confidence} confidence${best.domains?.length > 1 ? ` · ${best.domains.length} sites` : ''}`,
  }[best.source];
  return `<div class="stack" style="gap:10px">
    <div class="code-box"><div class="grow"><div class="tiny faint" style="margin-bottom:2px">${esc(src)}</div><div class="code-text">${esc(best.code)}</div></div>
      <button class="icon-btn" style="background:var(--card)" data-act="copy" data-text="${esc(best.code)}" aria-label="Copy code">${I.copy}</button></div>
    ${codes.length > 1 ? `<div class="stack" style="gap:6px"><div class="tiny faint">Backups, tap to copy</div><div class="alt-codes">${codes.slice(1).map((c) => `<button class="alt-code" data-act="copy" data-text="${esc(c.code)}">${esc(c.code)} ${I.copy}</button>`).join('')}</div></div>` : ''}
    <div class="row between wrap">
      ${best.scope && !guest ? `<div class="row small muted" style="gap:8px">Worked? <span class="votes">
        <button class="vote up ${best.myVote === 1 ? 'on' : ''}" data-act="vote" data-v="1" data-scope="${esc(best.scope)}" data-key="${esc(best.key)}" data-code="${esc(best.code)}">${I.thumbUp}</button>
        <button class="vote down ${best.myVote === -1 ? 'on' : ''}" data-act="vote" data-v="-1" data-scope="${esc(best.scope)}" data-key="${esc(best.key)}" data-code="${esc(best.code)}">${I.thumbDown}</button></span></div>` : '<span></span>'}
      ${editing || guest ? '' : `<button class="link-btn" data-act="code-edit" data-sale="${esc(sale.id)}">${best.source === 'you' ? 'Change code' : 'Use a different code'}</button>`}
    </div>
    ${editing ? form : ''}
    ${best.source === 'web' && best.snippet ? `<details class="small faint"><summary>Where it was found</summary><p style="margin-top:6px">“${esc(best.snippet)}”</p>${best.sourceUrl ? `<a href="${esc(best.sourceUrl)}" target="_blank" rel="noopener">${esc(new URL(best.sourceUrl).hostname)}</a>` : ''}</details>` : ''}
  </div>`;
}

function checklistItems(sale, best) {
  const items = [
    { id: 'signin', label: 'Signed in to the Ticketmaster app', hint: 'Sessions expire. Check now, not at 9:59.' },
    { id: 'pay', label: 'Card saved and up to date' },
  ];
  if (sale.requirement === 'register') {
    const show = findSale(sale.id)?.show;
    const n = show?.artistId ? (S.state?.signups ?? []).find((x) => x.artistId === show.artistId && x.at > now()) : null;
    items.push({ id: 'reg', label: 'Registered for this presale', hint: n ? `Sign-up closes ${fmtDay(n.at)}, ${fmtTime(n.at)}.` : 'Verified Fan and similar need sign-up ahead of time.', auto: !!n?.done });
  }
  if (sale.requirement === 'card') items.push({ id: 'card', label: 'Eligible card saved in Ticketmaster' });
  if (sale.kind === 'presale' && sale.requirement !== 'card') items.push({ id: 'code', label: best ? `Code ready: ${best.code}` : 'Code ready', auto: !!best });
  items.push({ id: 'plan', label: 'Know your budget and how many tickets', hint: 'Decide now so you can grab seats fast.' });
  return items;
}

function loadChecks(saleId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(`chk:${saleId}`) ?? '[]'));
  } catch {
    return new Set();
  }
}

function afterSale(show, nextSale) {
  if (S.guest && S.route.name === 'link')
    return `<div class="section"><div class="card stack" style="gap:12px"><p class="muted small">Done with this show? Either one updates your calendar.</p>
      <div class="btn-pair"><a class="btn primary" href="${esc(S.guest.links.got)}">${I.done} Got tickets</a><a class="btn" href="${esc(S.guest.links.hide)}">${I.eyeOff} Not for me</a></div></div></div>`;
  return `<div class="section"><div class="card stack" style="gap:12px">
    <p class="muted small">How did it go? Optional. Either one stops reminders for this show.</p>
    <div class="btn-pair"><button class="btn ${show.gotTickets ? 'soft' : 'primary'}" data-act="got" data-id="${esc(show.id)}">${I.done} ${show.gotTickets ? 'Going' : 'Got tickets'}</button>
      <button class="btn" data-act="hide-show" data-id="${esc(show.id)}" data-back="1">${I.eyeOff} Hide show</button></div>
    ${nextSale && !show.gotTickets ? `<hr class="sep" style="margin:2px 0"><div class="row tap" data-act="nav" data-href="#/go/${encodeURIComponent(nextSale.id)}"><div class="grow"><div class="small faint">Next chance</div><b>${esc(nextSale.name)}</b> <span class="muted small">${fmtDay(nextSale.startUtc)}, ${fmtTime(nextSale.startUtc)}</span></div><span class="chev">${I.chev}</span></div>` : ''}
  </div></div>`;
}

// ============================================================ activity

const ACT_ICON = { signup: I.flag, resale_deal: I.tag, new_show: I.music, new_sale: I.ticket, time_change: I.clock, status_change: I.alert, reminder: I.zap, code_found: I.key, tickets_back: I.radar };

function viewActivity() {
  const list = S.state.activity;
  const groups = new Map();
  for (const a of list) {
    const k = fmtDay(a.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return `<div class="screen">
    <div class="topbar"><div class="title">Activity</div></div>
    ${
      list.length
        ? [...groups.entries()]
            .map(
              ([k, items]) => `<div class="section" style="margin-top:14px"><div class="section-head"><h2>${esc(k)}</h2></div><div class="list">${items
                .map(
                  (a) => `<div class="act ${a.read ? '' : 'unread'}" data-act="nav" data-href="${esc(a.url ?? '#/')}">
                <div class="ic">${ACT_ICON[a.type] ?? I.bell}</div>
                <div class="grow"><div class="t">${esc(a.title)}</div>${a.body ? `<div class="small muted" style="white-space:pre-line">${esc(a.body)}</div>` : ''}
                <div class="tiny faint" style="margin-top:3px">${fmtTime(a.ts)}${a.pushedAt ? ' · notified' : a.priority === 'digest' ? ' · in roundup' : ''}</div></div></div>`,
                )
                .join('')}</div></div>`,
            )
            .join('')
        : `<div class="empty"><div class="ic">${I.bell}</div><p>New shows, presales and codes show up here. Only time-critical ones send a notification.</p></div>`
    }
  </div>`;
}

// ============================================================ settings

function viewSettings() {
  const st = S.state;
  const p = st.me.prefs;
  const f = st.features;
  const hourOpts = (sel) =>
    Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${new Date(2020, 0, 1, h).toLocaleTimeString('en-CA', { hour: 'numeric' }).replace(/\s?([ap])\.?m\.?/i, (_, a) => ` ${a.toUpperCase()}M`)}</option>`).join('');
  const reminderChip = (m) => `<button class="chip ${p.reminderMinutes.includes(m) ? 'on' : ''}" data-act="rem-min" data-v="${m}">${m >= 60 ? `${m / 60} hr` : `${m} min`}</button>`;
  const sync = st.jobs.sync;
  const issues = [
    !f.ticketmaster && 'Ticketmaster API key is missing, so no shows will load.',
    !f.push && 'Push keys are missing, so notifications are off.',
    !f.webSearch && 'Web search key is missing, so the code finder only checks fixed pages.',
    !f.soldOutWatch && 'Sold-out watch is off until Ticketmaster approves Inventory Status access.',
    !f.seatgeek && 'SeatGeek key is missing, so resale prices and shows sold outside Ticketmaster are off.',
  ].filter(Boolean);

  return `<div class="screen">
    <div class="topbar"><div class="title">Settings</div></div>

    <div class="section" style="margin-top:8px"><div class="section-head"><h2>Following</h2></div><div class="list">
      <div class="item tap" data-act="sheet" data-kind="venues">${I.building}<div class="grow">Venues</div><span class="muted">${st.venues.length}</span><span class="chev">${I.chev}</span></div>
      <div class="item tap" data-act="sheet" data-kind="artists">${I.mic}<div class="grow">Artists</div><span class="muted">${st.artists.length}</span><span class="chev">${I.chev}</span></div>
      <div class="item tap" data-act="sheet" data-kind="hidden">${I.eyeOff}<div class="grow">Muted and hidden</div><span class="muted">${st.muted.length + st.hidden.length}</span><span class="chev">${I.chev}</span></div>
    </div></div>

    <div class="section"><div class="section-head"><h2>Notifications</h2></div><div class="list">
      <div class="item">${I.phone}<div class="grow">Push on this device<div class="small muted" id="push-status">${f.pushDevices ? `${f.pushDevices} device${f.pushDevices > 1 ? 's' : ''} on` : 'Off'}</div></div>
        ${f.push && pushSupported() && !(isIOS() && !isStandalone()) ? `<button class="btn sm ${f.pushDevices ? 'soft' : 'primary'}" data-act="${f.pushDevices ? 'test-push' : 'enable-push'}">${f.pushDevices ? 'Test' : 'Turn on'}</button>` : '<span class="small faint">Add to Home Screen</span>'}</div>
      <div class="item" style="flex-direction:column;align-items:stretch;gap:10px"><div><b style="font-weight:500">Remind me before a sale</b><div class="small muted">Urgent pings, for artists you follow and shows you starred</div></div><div class="chips">${[60, 30, 15, 5].map(reminderChip).join('')}</div></div>
      <div class="item"><div class="grow">Also when a sale opens</div><input type="checkbox" class="switch" data-act="pref-bool" data-k="openPush" ${p.openPush ? 'checked' : ''}></div>
      <div class="item"><div class="grow">Evening roundup</div><select class="input" style="width:auto;min-height:38px;padding:6px 10px" data-act="pref-num" data-k="digestHour">${hourOpts(p.digestHour)}</select></div>
      <div class="item"><div class="grow">Quiet from</div><select class="input" style="width:auto;min-height:38px;padding:6px 10px" data-act="pref-num" data-k="quietStart">${hourOpts(p.quietStart)}</select><span class="muted small">to</span><select class="input" style="width:auto;min-height:38px;padding:6px 10px" data-act="pref-num" data-k="quietEnd">${hourOpts(p.quietEnd)}</select></div>
      <div class="item tap" data-act="digest-preview"><div class="grow">Send me tonight's roundup now</div><span class="chev">${I.chev}</span></div>
    </div><p class="tiny faint" style="margin:8px 4px">Urgent pings (sale starting, seats released) still come in quiet hours. Everything else waits.</p></div>

    <div class="section"><div class="section-head"><h2>Calendar</h2>${st.calendar?.lastSync ? `<span class="tiny faint">Synced ${ago(st.calendar.lastSync)}</span>` : ''}</div>
      ${st.calendar?.status === 'error' ? `<div class="banner warn" style="margin-bottom:10px">${I.alert}<span>${esc(st.calendar.lastError ?? 'Calendar sync failed.')}</span></div>` : ''}
      <div class="list">
      ${st.calendar
        ? `<div class="item">${I.phone}<div class="grow">iCloud<div class="small muted">${esc(st.calendar.username)} · ${st.calendar.events} sale${st.calendar.events === 1 ? '' : 's'} in "Presales"</div></div><button class="btn sm soft" data-act="cal-sync">Sync</button></div>
           <div class="item tap" data-act="sheet" data-kind="cal-disconnect"><div class="grow" style="color:var(--bad)">Disconnect</div></div>`
        : `<div class="item tap" data-act="sheet" data-kind="icloud">${I.phone}<div class="grow">Connect iPhone Calendar<div class="small muted">Instant: events appear, move and disappear on their own</div></div><span class="chev">${I.chev}</span></div>`}
      <a class="item tap" href="${esc(st.calendarUrl.replace(/^https?/, 'webcal'))}" style="color:inherit">${I.calendar}<div class="grow">Subscribe with a link<div class="small muted">For Google, Outlook and others. Slower to update.</div></div><span class="chev">${I.chev}</span></a>
      <div class="item tap" data-act="copy" data-text="${esc(st.calendarUrl)}">${I.copy}<div class="grow">Copy calendar link</div></div>
    </div><p class="tiny faint" style="margin:8px 4px">Each event links to a sale screen that works without signing in, plus "Got tickets" and "Not interested" links that clean up your calendar.</p></div>

    ${st.me.role === 'owner' ? `<div class="section"><div class="section-head"><h2>People</h2></div><div class="list">
      ${st.members.map((m) => `<div class="item">${I.user}<div class="grow"><b style="font-weight:600">${esc(m.name)}</b>${m.role === 'owner' ? ' <span class="pill">Owner</span>' : ''}<div class="small muted">${esc(m.email)}</div></div>${m.role !== 'owner' ? `<button class="icon-btn plain" data-act="del-user" data-id="${m.id}" data-name="${esc(m.name)}" aria-label="Remove">${I.trash}</button>` : ''}</div>`).join('')}
      <div class="item tap" data-act="invite">${I.plus}<div class="grow">Invite someone</div></div>
      ${S.ui.invite ? `<div class="item" style="flex-direction:column;align-items:stretch;gap:8px"><div class="small muted">Send this link. It works once and expires in 7 days.</div><div class="code-box" style="padding:8px 8px 8px 12px"><div class="grow small mono ellipsis">${esc(S.ui.invite)}</div><button class="icon-btn" data-act="share-invite" aria-label="Share">${I.share}</button></div></div>` : ''}
    </div></div>` : ''}

    <div class="section"><div class="list">
      <div class="item tap" data-act="toggle-advanced">${I.radar}<div class="grow">Sources and status<div class="small muted">${issues.length ? `${issues.length} thing${issues.length > 1 ? 's' : ''} to set up` : 'Code finder, venue websites, sync'}</div></div><span class="chev" style="transform:rotate(${S.ui.advanced ? 90 : 0}deg)">${I.chev}</span></div>
    </div></div>
    ${S.ui.advanced ? `    <div class="section"><div class="section-head"><h2>Code finder</h2><button class="link-btn" data-act="codes-refresh">Scan now</button></div><div class="list">
      ${st.codeSources
        .map(
          (s) => `<div class="item"><div class="grow"><div class="ellipsis small"><b style="font-weight:600">${esc(s.label || new URL(s.url).hostname)}</b></div>
          <div class="tiny ${s.lastError ? '' : 'faint'}" style="${s.lastError ? 'color:var(--bad)' : ''}">${s.enabled ? (s.lastError ? esc(s.lastError) : s.lastChecked ? `Checked ${ago(s.lastChecked)} · ${s.lastFound} found` : 'Not checked yet') : 'Off'}</div></div>
          <button class="icon-btn plain" data-act="del-source" data-url="${esc(s.url)}" aria-label="Remove">${I.trash}</button></div>`,
        )
        .join('')}
      <div class="item tap" data-act="sheet" data-kind="add-source">${I.plus}<div class="grow">Add a page to scan</div></div>
      ${st.artistCodes.length ? `<div class="item tap" data-act="sheet" data-kind="saved-codes">${I.key}<div class="grow">Your saved codes</div><span class="muted">${st.artistCodes.length}</span><span class="chev">${I.chev}</span></div>` : ''}
    </div><p class="tiny faint" style="margin:8px 4px">Checks Ticketmaster's own presale text, the official Live Nation password, ${f.webSearch ? 'web searches for each upcoming presale, ' : ''}and these pages. Scans get more frequent as a presale gets close.</p></div>

    <div class="section"><div class="section-head"><h2>Venue websites</h2></div><div class="list">
      ${(st.venuePages ?? [])
        .map(
          (p) => `<div class="item"><div class="grow"><div class="ellipsis small"><b style="font-weight:600">${esc(p.venue ?? p.label ?? new URL(p.url).hostname)}</b></div>
          <div class="tiny ${p.lastError ? '' : 'faint'}" style="${p.lastError ? 'color:var(--bad)' : ''}">${p.lastError ? esc(p.lastError) : p.lastChecked ? `Checked ${ago(p.lastChecked)} · ${p.lastFound} shows` : 'Checking…'}</div></div>
          <button class="icon-btn plain" data-act="del-venue-page" data-url="${esc(p.url)}" aria-label="Remove">${I.trash}</button></div>`,
        )
        .join('')}
      <div class="item tap" data-act="sheet" data-kind="add-venue-page">${I.plus}<div class="grow">Add a venue's events page<div class="small muted">Catches shows sold outside Ticketmaster</div></div></div>
    </div></div>

    <div class="section"><div class="section-head"><h2>Status</h2>${sync?.lastEnd ? `<span class="tiny faint">Synced ${ago(sync.lastEnd)}</span>` : ''}</div>
      ${issues.length ? `<div class="stack" style="gap:8px">${issues.map((i) => `<div class="banner warn">${I.alert}<span>${i}</span></div>`).join('')}</div>` : `<div class="banner">${I.done}<span>Everything is connected.</span></div>`}
      ${st.venues.concat(st.artists).some((x) => x.lastError) ? `<p class="small" style="color:var(--bad);margin:8px 4px">Some sources failed on their last sync. They retry automatically.</p>` : ''}
      <div class="list" style="margin-top:10px">
        ${[['ticketmaster', 'Ticketmaster', 4500], ['seatgeek', 'SeatGeek', 5000], ['brave', 'Web searches', 30], ['web', 'Web pages', 3000]]
          .filter(([k]) => k !== 'seatgeek' || f.seatgeek)
          .map(([k, label, limit]) => {
            const used = st.budgets?.[k] ?? 0;
            return `<div class="item"><div class="grow small">${label} today</div><div class="small muted">${used.toLocaleString()} / ${limit.toLocaleString()}</div></div>`;
          })
          .join('')}
      </div>
      <p class="tiny faint" style="margin:8px 4px">Checks run more often near sales and on weekday mornings, when tours are announced, and less often for quiet venues. Each sale you care about is re-checked 45 and 10 minutes before it starts.</p>
      <button class="btn block soft" style="margin-top:10px" data-act="refresh-now">${I.refresh} Check for new shows now</button>
    </div>

` : ''}
    <div class="section"><div class="section-head"><h2>Account</h2></div><div class="list">
      <div class="item">${I.user}<div class="grow"><b style="font-weight:600">${esc(st.me.name)}</b><div class="small muted">${esc(st.me.email)}</div></div></div>
      <div class="item tap" data-act="logout">${I.logout}<div class="grow">Sign out</div></div>
    </div></div>
    <p class="tiny faint" style="text-align:center;margin-top:20px">Presale Radar${f.demo ? ' · demo mode' : ''}</p>
  </div>`;
}

// ============================================================ sheets

function openSheet(kind, extra = {}) {
  S.ui.sheet = { kind, ...extra };
  S.ui.sheetResults = null;
  render();
  setTimeout(() => document.querySelector('.sheet input[data-search]')?.focus(), 250);
}

function closeSheet() {
  S.ui.sheet = null;
  S.ui.sheetResults = null;
  render();
}

function sheetHtml() {
  const sh = S.ui.sheet;
  if (!sh) return '';
  const st = S.state;
  let body = '';
  if (sh.kind === 'venues') {
    const mine = new Set(st.venues.map((v) => v.id));
    body = `<h2>Venues</h2><p class="small muted" style="margin:4px 0 14px">Shows here appear in your feed and roundup. Turn on "Every show" to get reminders for all of them.</p>
      <div class="search" style="margin-bottom:12px">${I.search}<input class="input" data-search="sheet-venues" placeholder="Add a venue"></div>
      ${S.ui.sheetResults ? `<div class="list" style="margin-bottom:16px">${S.ui.sheetResults.length ? S.ui.sheetResults.map((v) => `<div class="item"><div class="grow"><b style="font-weight:600">${esc(v.name)}</b><div class="small muted">${esc(v.city ?? '')}</div></div><button class="btn sm ${mine.has(v.id) ? 'soft' : 'primary'}" data-act="toggle-venue" data-id="${esc(v.id)}" data-name="${esc(v.name)}" data-city="${esc(v.city ?? '')}">${mine.has(v.id) ? 'Added' : 'Add'}</button></div>`).join('') : '<div class="item muted">No venues found</div>'}</div>` : ''}
      <div class="list">${st.venues.length ? st.venues.map((v) => `<div class="item"><div class="grow"><b style="font-weight:600">${esc(v.name)}</b><div class="tiny ${v.lastError ? '' : 'faint'}" style="${v.lastError ? 'color:var(--bad)' : ''}">${v.lastError ? 'Sync failed, retrying' : `Synced ${ago(v.lastSynced)}`}</div></div>
        <span class="tiny muted">Every show</span><input type="checkbox" class="switch" data-act="venue-all" data-id="${esc(v.id)}" ${v.remindAll ? 'checked' : ''}>
        <button class="icon-btn plain" data-act="toggle-venue" data-id="${esc(v.id)}" data-name="${esc(v.name)}" aria-label="Remove">${I.trash}</button></div>`).join('') : '<div class="item muted">No venues yet</div>'}</div>`;
  } else if (sh.kind === 'artists') {
    const mine = new Set(st.artists.map((a) => a.id));
    body = `<h2>Artists</h2><p class="small muted" style="margin:4px 0 14px">You get reminders for every sale by these artists near you.</p>
      <div class="search" style="margin-bottom:12px">${I.search}<input class="input" data-search="sheet-artists" placeholder="Add an artist"></div>
      ${S.ui.sheetResults ? `<div class="list" style="margin-bottom:16px">${S.ui.sheetResults.length ? S.ui.sheetResults.map((a) => artistRow(a, mine.has(a.id))).join('') : '<div class="item muted">No artists found</div>'}</div>` : ''}
      <div class="list">${st.artists.length ? st.artists.map((a) => `<div class="item"><div class="grow"><b style="font-weight:600">${esc(a.name)}</b></div><button class="icon-btn plain" data-act="toggle-artist" data-id="${esc(a.id)}" data-name="${esc(a.name)}" aria-label="Unfollow">${I.trash}</button></div>`).join('') : '<div class="item muted">No artists yet</div>'}</div>`;
  } else if (sh.kind === 'hidden') {
    body = `<h2>Muted and hidden</h2>
      <div class="section-head" style="margin-top:16px"><h2>Muted artists</h2></div>
      <div class="list">${st.muted.length ? st.muted.map((a) => `<div class="item"><div class="grow">${esc(a.name)}</div><button class="btn sm soft" data-act="unmute" data-id="${esc(a.id)}">Unmute</button></div>`).join('') : '<div class="item muted small">None</div>'}</div>
      <div class="section-head" style="margin-top:18px"><h2>Hidden shows</h2></div>
      <div class="list">${st.hidden.filter((h) => h.reason === 'hidden').length ? st.hidden.filter((h) => h.reason === 'hidden').map((s) => `<div class="item"><div class="grow"><b style="font-weight:600">${esc(s.artist)}</b><div class="small muted">${esc(s.venue ?? '')} · ${fmtLocalDate(s.date)}</div></div><button class="btn sm soft" data-act="unhide-show" data-id="${esc(s.id)}">Unhide</button></div>`).join('') : '<div class="item muted small">None</div>'}</div>`;
  } else if (sh.kind === 'add-source') {
    body = `<h2>Add a page to scan</h2><p class="small muted" style="margin:4px 0 14px">Any public page where people post presale codes, like a forum thread or a code roundup. It's checked every few hours, and more often before a presale.</p>
      <form class="stack" data-form="source"><div class="field"><label>Web address</label><input class="input" name="url" type="url" inputmode="url" placeholder="https://" required></div>
      <div class="field"><label>Name (optional)</label><input class="input" name="label" placeholder="Fan forum"></div><div class="error"></div>
      <button class="btn primary block" type="submit">Add page</button></form>`;
  } else if (sh.kind === 'add-venue-page') {
    body = `<h2>Add a venue's events page</h2><p class="small muted" style="margin:4px 0 14px">Paste the page on the venue's site that lists upcoming shows. Most sites include machine-readable listings. An .ics calendar link works too.</p>
      <form class="stack" data-form="venue-page" novalidate>
        <div class="field"><label>Events page</label><input class="input" name="url" type="url" inputmode="url" placeholder="https://venue.com/events" required></div>
        <div class="field"><label>Which venue is it?</label><select class="input" name="venueId"><option value="">Not one of my venues</option>${st.venues.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></div>
        <div class="error"></div><button class="btn primary block" type="submit">Add and check now</button></form>`;
  } else if (sh.kind === 'icloud') {
    body = `<h2>Connect iPhone Calendar</h2><p class="small muted" style="margin:4px 0 14px">Presale Radar adds a "Presales" calendar to your iCloud and keeps it up to date. Apple needs an app-specific password, which only works for calendars and can be revoked any time.</p>
      <div class="ios-steps small" style="margin-bottom:16px">
        <div>Open <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener">account.apple.com</a> and sign in</div>
        <div>Go to Sign-In and Security, then App-Specific Passwords</div>
        <div>Create one called "Presales" and paste it below</div></div>
      <form class="stack" data-form="icloud" novalidate>
        <div class="field"><label>Apple ID email</label><input class="input" name="email" type="email" autocomplete="username" placeholder="you@icloud.com" required></div>
        <div class="field"><label>App-specific password</label><input class="input mono" style="text-transform:none" name="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx" required></div>
        <div class="error"></div>
        <button class="btn primary block" type="submit">Connect</button></form>`;
  } else if (sh.kind === 'cal-disconnect') {
    body = `<h2>Disconnect calendar?</h2><p class="small muted" style="margin:4px 0 16px">Presale Radar stops updating your iCloud calendar.</p>
      <div class="stack"><button class="btn block danger" data-act="cal-disconnect" data-remove="1">Disconnect and delete the Presales calendar</button>
      <button class="btn block" data-act="cal-disconnect" data-remove="0">Disconnect, keep the events</button></div>`;
  } else if (sh.kind === 'saved-codes') {
    body = `<h2>Your saved codes</h2><p class="small muted" style="margin:4px 0 14px">Used automatically for that artist's other dates.</p>
      <div class="list">${st.artistCodes.map((c) => `<div class="item"><div class="grow"><b style="font-weight:600">${esc(c.artist ?? c.artistId)}</b><div class="small muted">${esc(c.saleSlug.replace(/-/g, ' '))}</div></div><span class="mono"><b>${esc(c.code)}</b></span></div>`).join('')}</div>`;
  }
  return `<div class="sheet-back" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${body}
    <button class="btn ghost block" style="margin-top:14px" data-act="sheet-close">Done</button></div></div>`;
}

// ============================================================ actions

async function mutate(fn, { reload = true, msg, undo } = {}) {
  try {
    await fn();
    if (reload) await loadState();
    render();
    if (msg) toast(msg, undo);
  } catch (e) {
    if (e.message !== 'signed out') toast(e.message);
  }
}

function hideShow(id, { back = false } = {}) {
  const s = findShow(id);
  mutate(() => api(`/api/shows/${encodeURIComponent(id)}`, { body: { state: 'dismissed' } }), {
    msg: `Hid ${s?.artist ?? 'show'}`,
    undo: () => mutate(() => api(`/api/shows/${encodeURIComponent(id)}`, { body: { state: 'auto' } })),
  });
  if (back) history.length > 1 ? history.back() : go('#/');
}

async function saveCode(form, data) {
  const saleId = form.dataset.sale;
  await api(`/api/sales/${encodeURIComponent(saleId)}/code`, { body: { code: data.code ?? '', remember: !!data.remember } });
  S.ui.codeEdit = null;
  await loadState();
  render();
  toast(data.code ? 'Code saved' : 'Code removed');
}

async function addSource(form, data) {
  await api('/api/code-sources', { body: data });
  await loadState();
  closeSheet();
  toast('Page added. Scanning now.');
}

const handlers = {
  nav: (el) => {
    if (el.closest('.card')?.dataset.justSwiped || el.dataset.justSwiped) return;
    go(el.dataset.href);
  },
  back: () => (history.length > 1 ? history.back() : go('#/')),
  noop: () => {},
  'toggle-advanced': () => {
    S.ui.advanced = !S.ui.advanced;
    render();
  },
  'why-reminding': (el) =>
    toast(
      el.dataset.reason === 'artist'
        ? `On because you follow ${el.dataset.artist}. Use Hide or Mute to stop.`
        : `On for every show at ${el.dataset.venue}. Change it in Settings, then Venues.`,
    ),
  'toast-undo': () => {
    toastEl.classList.remove('show');
    toastEl._undo?.();
  },
  copy: async (el) => toast((await copy(el.dataset.text)) ? 'Copied' : "Couldn't copy"),

  // onboarding
  'onb-next': () => {
    S.ui.onbStep = Math.min(ONB_STEPS - 1, S.ui.onbStep + 1);
    S.ui.venueResults = null;
    S.ui.artistResults = null;
    if (S.ui.onbStep === 1) S.ui.suggested = null;
    render();
    window.scrollTo(0, 0);
  },
  'onb-skip-push': () => {
    localStorage.setItem('nudge-push', 'no');
    handlers['onb-next']();
  },
  'onb-back': () => {
    S.ui.onbStep = Math.max(0, S.ui.onbStep - 1);
    render();
  },
  'onb-finish': () => mutate(() => api('/api/onboarded', { body: {} }), { msg: "You're all set" }),

  // follows
  'toggle-venue': (el) => {
    const on = S.state.venues.some((v) => v.id === el.dataset.id);
    el.classList.toggle('on', !on);
    mutate(() =>
      on
        ? api(`/api/venues/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' })
        : api('/api/venues', { body: { id: el.dataset.id, name: el.dataset.name, city: el.dataset.city || null } }),
    );
  },
  'venue-all': (el) => mutate(() => api(`/api/venues/${encodeURIComponent(el.dataset.id)}`, { method: 'PATCH', body: { remindAll: el.checked } })),
  'toggle-artist': (el) => {
    const on = S.state.artists.some((a) => a.id === el.dataset.id);
    el.classList.toggle('on', !on);
    mutate(() =>
      on
        ? api(`/api/artists/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' })
        : api('/api/artists', { body: { id: el.dataset.id, name: el.dataset.name, image: el.dataset.image || null } }),
    );
  },
  mute: (el) =>
    mutate(() => api('/api/mute-artist', { body: { id: el.dataset.id, name: el.dataset.name } }), {
      msg: `Muted ${el.dataset.name}`,
      undo: () => mutate(() => api(`/api/artists/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' })),
    }),
  unmute: (el) => mutate(() => api(`/api/artists/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' }), { msg: 'Unmuted' }),

  // shows
  star: (el) => {
    const s = findShow(el.dataset.id);
    mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { state: 'tracked', seen: true } }), {
      msg: `Reminders on for ${s?.artist ?? 'this show'}`,
      undo: () => mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { state: 'auto' } })),
    });
  },
  unstar: (el) => mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { state: 'auto' } }), { msg: 'Reminders off' }),
  'hide-show': (el) => hideShow(el.dataset.id, { back: !!el.dataset.back }),
  'unhide-show': (el) => mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { state: 'auto' } }), { msg: 'Show is back' }),
  got: (el) => {
    const s = findShow(el.dataset.id);
    const next = !s?.gotTickets;
    mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { gotTickets: next } }), {
      msg: next ? 'Enjoy the show! Reminders stopped.' : 'Unmarked',
    });
  },
  'signup-done': (el) =>
    mutate(() => api('/api/signups/done', { body: { artistId: el.dataset.artist, label: el.dataset.label, at: Number(el.dataset.at) } }), {
      msg: "Got it. No more sign-up reminders for this one.",
    }),
  'del-venue-page': (el) => mutate(() => api(`/api/venue-pages?url=${encodeURIComponent(el.dataset.url)}`, { method: 'DELETE' }), { msg: 'Removed' }),
  'pick-day': (el) => {
    S.ui.day = el.dataset.k;
    render();
  },
  'toggle-later': () => {
    S.ui.showLater = !S.ui.showLater;
    render();
  },
  deck: (el) => deckDecide(el.dataset.v),
  'deck-undo': () => deckUndo(),
  'deck-close': () => {
    S.ui.deck = null;
    go('#/');
  },
  'deck-done': () => {
    S.ui.deck = null;
    go('#/');
  },
  'launch-exit': (el) => {
    S.ui.launchOff = [...(S.ui.launchOff ?? []), el.dataset.sale];
    render();
  },
  'cal-sync': () => mutate(() => api('/api/calendar/sync', { body: {} }), { msg: 'Syncing your calendar' }),
  'cal-disconnect': (el) => {
    closeSheet();
    mutate(() => api(`/api/calendar?remove=${el.dataset.remove}`, { method: 'DELETE' }), { msg: 'Calendar disconnected' });
  },
  'resale-watch': (el) => {
    const show = findShow(el.dataset.id);
    mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { resale: { watch: el.checked, target: show?.resale?.customTarget ?? null } } }), {
      msg: el.checked ? "Resale watch on. You'll hear about real price drops only." : 'Resale watch off',
    });
  },
  watch: (el) => mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.id)}`, { body: { watchSoldout: el.checked } })),
  'seen-all': () => mutate(() => api('/api/shows/seen', { body: { ids: newAtVenues().map((s) => s.id) } })),
  'shows-filter': (el) => {
    S.ui.showsFilter = el.dataset.v;
    render();
  },

  // sale day
  buy: (el) => {
    const found = findSale(el.dataset.sale);
    if (!found) return;
    const code = found.sale.codes?.[0]?.code;
    if (code) copy(code); // must stay inside the tap for clipboard access
    const url = found.sale.url || found.show.url;
    if (url) window.open(url, '_blank', 'noopener');
    if (code) toast(`Copied ${code}`);
  },
  check: (el) => {
    const set = loadChecks(el.dataset.sale);
    set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id);
    localStorage.setItem(`chk:${el.dataset.sale}`, JSON.stringify([...set]));
    render();
  },
  'code-edit': (el) => {
    S.ui.codeEdit = el.dataset.sale;
    render();
    setTimeout(() => document.querySelector('form[data-form=code] input[name=code]')?.focus(), 50);
  },
  'code-cancel': () => {
    S.ui.codeEdit = null;
    render();
  },
  vote: (el) => {
    const v = Number(el.dataset.v);
    const current = el.classList.contains('on');
    mutate(() => api('/api/codes/vote', { body: { scope: el.dataset.scope, key: el.dataset.key, code: el.dataset.code, vote: current ? 0 : v } }), {
      msg: current ? undefined : v === 1 ? 'Thanks! It goes to the top for everyone.' : "Got it. We'll stop suggesting it.",
    });
  },

  // settings
  sheet: (el) => openSheet(el.dataset.kind),
  'sheet-close': closeSheet,
  'sheet-close-bg': (el, e) => {
    if (e.target === el) closeSheet();
  },
  'rem-min': (el) => {
    const m = Number(el.dataset.v);
    const cur = new Set(S.state.me.prefs.reminderMinutes);
    cur.has(m) ? cur.delete(m) : cur.add(m);
    if (!cur.size) return toast('Keep at least one reminder');
    mutate(() => api('/api/prefs', { body: { reminderMinutes: [...cur] } }));
  },
  'pref-bool': (el) => mutate(() => api('/api/prefs', { body: { [el.dataset.k]: el.checked } })),
  'digest-preview': () => mutate(async () => {
    const r = await api('/api/digest/preview', { body: {} });
    toast(r.sent ? 'Roundup sent' : 'Nothing to round up right now');
  }, { reload: false }),
  'enable-push': (el) => enablePush(!!el.dataset.next),
  'test-push': () => mutate(async () => {
    const r = await api('/api/push/test', { body: {} });
    toast(r.delivered ? 'Sent. Check your notifications.' : "Couldn't reach this device. Try turning push off and on.");
  }, { reload: false }),
  'nudge-no': () => {
    localStorage.setItem('nudge-push', 'no');
    render();
  },
  'codes-refresh': () => mutate(async () => {
    toast('Scanning…');
    const r = await api('/api/codes/refresh', { body: {} });
    toast(r.newCodes ? `Found ${r.newCodes} new code${r.newCodes > 1 ? 's' : ''}` : 'No new codes');
  }),
  'del-source': (el) => mutate(() => api(`/api/code-sources?url=${encodeURIComponent(el.dataset.url)}`, { method: 'DELETE' }), { msg: 'Removed' }),
  invite: async () => {
    try {
      S.ui.invite = (await api('/api/invites', { body: {} })).url;
      render();
    } catch (e) {
      toast(e.message);
    }
  },
  'share-invite': async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Presale Radar', text: 'Join me on Presale Radar so you never miss a presale', url: S.ui.invite });
        return;
      } catch {}
    }
    toast((await copy(S.ui.invite)) ? 'Link copied' : "Couldn't copy");
  },
  'del-user': (el) => {
    if (!confirm(`Remove ${el.dataset.name}? Their follows and settings are deleted.`)) return;
    mutate(() => api(`/api/users/${el.dataset.id}`, { method: 'DELETE' }), { msg: 'Removed' });
  },
  'refresh-now': () => mutate(async () => {
    toast('Checking…');
    const r = await api('/api/refresh', { body: {} });
    toast(r.busy ? 'Already checking. Try again in a minute.' : r.changes ? `${r.changes} update${r.changes > 1 ? 's' : ''}` : 'Up to date');
  }),
  'demo-tick': () => mutate(async () => {
    await api('/api/demo/tick', { body: {} });
    toast('Ran one scheduler tick');
  }),
  logout: async () => {
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    S.state = null;
    await loadAuth();
    location.hash = '#/';
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // handled on change
  const fn = handlers[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('#') === false) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) handlers[el.dataset.act]?.(el, e);
  if (el.matches('[data-resale-target]')) {
    const v = Math.round(Number(el.value));
    if (!(v > 0)) return toast('Enter a price');
    mutate(() => api(`/api/shows/${encodeURIComponent(el.dataset.resaleTarget)}`, { body: { resale: { watch: true, target: v } } }), { msg: `We'll ping you at $${v} or less` });
  }
  if (el.matches('select[data-act=pref-num]')) mutate(() => api('/api/prefs', { body: { [el.dataset.k]: Number(el.value) } }));
});

// ---- search boxes (debounced)

let searchTimer;
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-search]');
  if (!el) return;
  const kind = el.dataset.search;
  const q = el.value;
  if (kind === 'shows') {
    S.ui.showsQuery = q;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const pos = el.selectionStart;
      render();
      const again = document.querySelector('[data-search=shows]');
      again?.focus();
      again?.setSelectionRange(pos, pos);
    }, 150);
    return;
  }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const isVenue = kind.includes('venues');
    const key = kind.startsWith('sheet') ? 'sheetResults' : isVenue ? 'venueResults' : 'artistResults';
    if (q.trim().length < 2) {
      S.ui[key] = null;
    } else {
      try {
        S.ui[key] = (await api(`/api/search/${isVenue ? 'venues' : 'artists'}?q=${encodeURIComponent(q.trim())}`)).results;
      } catch (err) {
        toast(err.message);
      }
    }
    const value = el.value;
    render();
    const again = document.querySelector(`[data-search="${kind}"]`);
    if (again) {
      again.value = value;
      again.focus();
      again.setSelectionRange(value.length, value.length);
    }
  }, 300);
});

// ============================================================ service worker + push

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('SW registration failed', e);
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) location.hash = e.data.url.replace(/^.*#/, '#');
    if (e.data?.type === 'refresh') refresh();
  });
}

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush(advance) {
  try {
    if (!pushSupported()) throw new Error("This browser can't receive notifications.");
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your phone settings.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(S.state.features.vapidPublicKey) });
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    await loadState();
    toast('Notifications on');
    if (advance) S.ui.onbStep = Math.min(ONB_STEPS - 1, S.ui.onbStep + 1);
    render();
  } catch (e) {
    toast(e.message);
  }
}

boot();
