/* ================================================================== */
/* Sold — Discord-like client: real-time chat + WebRTC voice/video  */
/* ================================================================== */

const $ = (id) => document.getElementById(id);

const socket = io();

const state = {
  me: null,                 // {id, name, color}
  channels: [],
  users: [],
  participants: [],         // voice participants across the server
  activeText: null,
};

const voice = {
  channel: null,
  localStream: null,        // audio
  camStream: null,          // camera video
  screenStream: null,       // screen-share video
  peers: new Map(),         // socketId -> { pc, name, color, polite, makingOffer, ignoreOffer, pending }
  muted: false,
  deafened: false,
  cameraOn: false,
  screenOn: false,
};

const typingMap = new Map(); // userId -> { name, timeout }
const unreadMap = new Map(); // channelId -> count of messages missed while elsewhere
const speakingSet = new Set(); // ids currently detected as speaking (audio analysis)

const EMOJIS = ['😀','😂','😅','🤣','😊','😍','😘','😜','🤔','😎','🥳','😴','😭','😱','🤯','🥶',
  '👍','👎','👏','🙏','💪','🤝','✌️','🤞','🔥','✨','🎉','❤️','💙','💚','💯','⭐',
  '🎮','🎬','🎵','☕','🍕','🍔','🚀','💡','📌','💻','📱','🎧','📸','🌈','🌙','😴'];

/* STUN for direct peer-to-peer paths, TURN as a worldwide relay fallback.
 * TURN credentials are fetched fresh from our /api/turn proxy (Cloudflare's
 * global TURN network) because the upstream endpoint blocks cross-origin use. */
const BASE_STUN = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
  },
];

let RTC_CONFIG = { iceServers: [...BASE_STUN], iceCandidatePoolSize: 10 };

async function refreshIceConfig() {
  try {
    const res = await fetch('/api/turn', { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    const data = await res.json();
    const stun = (data.urls || []).filter((u) => u.startsWith('stun:'));
    const turn = (data.urls || []).filter((u) => !u.startsWith('stun:'));
    const servers = [...BASE_STUN];
    if (stun.length) servers.push({ urls: stun });
    if (turn.length && data.username && data.credential) {
      servers.push({ urls: turn, username: data.username, credential: data.credential });
    }
    RTC_CONFIG = { iceServers: servers, iceCandidatePoolSize: 10 };
  } catch (err) {
    console.warn('ICE config fetch failed:', err.message);
  }
  return RTC_CONFIG;
}

refreshIceConfig();
setInterval(refreshIceConfig, 7 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function toast(text, type) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'toast' + (type ? ' ' + type : '');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

/* human date phrasing: "Today at 2:41 PM" */
function fmtFull(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now.getTime() - 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

/* soft two-tone avatar gradients instead of flat blocks of color */
function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v + amt))));
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function gradientFor(color) {
  return `linear-gradient(140deg, ${shade(color, 42)} 0%, ${color} 55%, ${shade(color, -30)} 100%)`;
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '😮'];

function reactionsHtml(reactions) {
  const entries = Object.entries(reactions || {});
  if (!entries.length) return '';
  return '<div class="msg-reactions">' + entries.map(([emoji, voters]) =>
    `<button type="button" class="reaction${voters.includes(socket.id) ? ' mine' : ''}"` +
    ` data-emoji="${emoji}" title="${voters.length} reaction${voters.length === 1 ? '' : 's'}">` +
    `<span class="r-emoji">${emoji}</span><span class="r-count">${voters.length}</span></button>`
  ).join('') + '</div>';
}

const reactionsBarHtml =
  '<div class="msg-actions">' +
  REACTION_EMOJIS.map((e) => `<button type="button" class="msg-act" data-emoji="${e}" title="React with ${e}">${e}</button>`).join('') +
  '</div>';

const channelById = (id) => state.channels.find((c) => c.id === id);
const participantById = (id) => state.participants.find((p) => p.id === id);

/* ------------------------------------------------------------------ */
/* Auth: sign in / create account                                       */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = 'sold-token';

// migrate storage keys from the pre-rename ('confide-*') era so existing
// sessions and preferences survive the rename
try {
  [['confide-token', 'sold-token'],
   ['confide-username', 'sold-username'],
   ['confide-members-hidden', 'sold-members-hidden']].forEach(([from, to]) => {
    const v = localStorage.getItem(from);
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
    localStorage.removeItem(from);
  });
} catch (_) {}

let authMode = 'login'; // 'login' | 'signup'

function showLogin(message) {
  $('login-overlay').classList.remove('hidden');
  setAuthError(message || '');
  setTimeout(() => $('auth-username').focus(), 50);
}

function setAuthError(message) {
  const el = $('auth-error');
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    el.classList.remove('shake');
  } else {
    el.textContent = message;
    el.classList.remove('hidden');
    // replay the shake animation on every failure
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
}

function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-signup').classList.toggle('active', mode === 'signup');
  $('auth-title').textContent = mode === 'login' ? 'Good to see you again' : 'Make yourself at home';
  $('auth-sub').textContent =
    mode === 'login'
      ? 'Your people are already here. Jump back in.'
      : "Pick a name — it's how people will find you.";
  $('auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('auth-password2').classList.toggle('hidden', mode !== 'signup');
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  setAuthError('');
}

async function submitAuth() {
  const username = $('auth-username').value.trim().slice(0, 24);
  const password = $('auth-password').value;
  const password2 = $('auth-password2').value;

  if (!username) { setAuthError('Enter a username.'); return $('auth-username').focus(); }
  if (!password) { setAuthError('Enter a password.'); return $('auth-password').focus(); }
  if (authMode === 'signup') {
    if (password.length < 6) return setAuthError('Password must be at least 6 characters.');
    if (password !== password2) return setAuthError('Passwords do not match.');
  }

  const btn = $('auth-submit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Working…';

  try {
    const res = await fetch(`/api/${authMode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem('sold-username', data.user.username);
    $('auth-password').value = '';
    $('auth-password2').value = '';
    $('login-overlay').classList.add('hidden');
    setAuthError('');
    joinWithToken(data.token);
    if (authMode === 'signup') toast(`Welcome to Sold, ${data.user.username}!`, 'success');
    else toast(`Welcome back, ${data.user.username}!`, 'success');
  } catch (err) {
    setAuthError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function joinWithToken(token) {
  if (socket.connected) socket.emit('join', { token });
  else socket.connect(); // 'connect' handler will join with the stored token
}

function currentToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

$('auth-submit').addEventListener('click', submitAuth);
$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-signup').addEventListener('click', () => setAuthMode('signup'));

$('auth-username').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (authMode === 'signup') $('auth-password').focus();
  else submitAuth();
});
$('auth-password').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (authMode === 'signup') $('auth-password2').focus();
  else submitAuth();
});
$('auth-password2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

$('panel-logout').addEventListener('click', async () => {
  const token = currentToken();
  if (token) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (_) { /* server will drop the session on restart anyway */ }
  }
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  if (voice.channel) leaveVoice();
  socket.disconnect();
  state.me = null;
  showLogin();
  $('me-name').textContent = '…';
  $('me-status').textContent = 'Signed out';
});

/* ------------------------------------------------------------------ */
/* Socket events                                                       */
/* ------------------------------------------------------------------ */

socket.on('connect', () => {
  const token = currentToken();
  if (token) {
    socket.emit('join', { token });
  } else {
    showLogin();
  }
  $('me-status').textContent = state.me ? 'Online' : 'Connecting…';
});

socket.on('join:error', ({ error } = {}) => {
  // token missing/expired/revoked — send the user back to the auth screen
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  state.me = null;
  showLogin(error || 'Your session expired — please sign in again.');
});

socket.on('disconnect', () => {
  $('me-status').textContent = 'Disconnected';
  if (voice.channel) leaveVoice(true);
});

socket.on('init', (data) => {
  state.me = data.me;
  state.channels = data.channels;
  state.users = data.users;
  state.participants = data.voice;
  renderChannels();
  renderMembers();
  $('me-avatar').textContent = initial(data.me.name);
  $('me-avatar').style.background = gradientFor(data.me.color);
  $('me-name').textContent = data.me.name;
  $('me-status').textContent = 'Online';
  if (!state.activeText || !channelById(state.activeText)) {
    const firstText = state.channels.find((c) => c.type === 'text');
    if (firstText) openChannel(firstText.id);
  } else {
    openChannel(state.activeText);
  }
  if (voice.channel) renderVoiceParticipants();
});

socket.on('channels', (channels) => {
  state.channels = channels;
  renderChannels();
  if (state.activeText && channelById(state.activeText)?.type === 'text') openChannel(state.activeText);
});

socket.on('users', (users) => { state.users = users; renderMembers(); });

socket.on('voice:update', (list) => {
  state.participants = list;
  renderMembers();
  renderVoiceParticipants();
  updateTilesFromState();
});

socket.on('text:history', ({ channelId, messages }) => {
  if (channelId !== state.activeText) return;
  renderHistory(messages);
});

socket.on('text:message', (msg) => {
  if (msg.channelId === state.activeText) {
    appendMessage(msg);
  } else if (msg.userId !== socket.id) {
    // missed a message in another channel → unread pill + white indicator
    unreadMap.set(msg.channelId, (unreadMap.get(msg.channelId) || 0) + 1);
    renderChannels();
  }
});

socket.on('text:reaction', ({ channelId, messageId, reactions }) => {
  if (channelId !== state.activeText) return;
  const group = document.querySelector(`#messages .msg-group[data-id="${messageId}"]`);
  if (!group) return;
  const body = group.querySelector('.msg-body');
  if (!body) return;
  const old = body.querySelector('.msg-reactions');
  if (old) old.remove();
  const html = reactionsHtml(reactions);
  if (html) body.insertAdjacentHTML('beforeend', html);
});

socket.on('typing', ({ channelId, userId, name }) => {
  if (channelId !== state.activeText || userId === socket.id) return;
  const existing = typingMap.get(userId);
  if (existing) clearTimeout(existing.timeout);
  const entry = {
    name,
    timeout: setTimeout(() => { typingMap.delete(userId); renderTyping(); }, 3500),
  };
  typingMap.set(userId, entry);
  renderTyping();
});

/* ---------------- voice events ---------------- */

socket.on('voice:peers', ({ channel, peers }) => {
  if (channel !== voice.channel) return;
  peers.forEach((p) => createPeer(p.id, p, true));
  updateConnLabel();
});

socket.on('voice:signal', ({ from, data }) => {
  if (!voice.channel) return;
  handleSignal(from, data);
});

socket.on('voice:leave', ({ peerId }) => {
  removePeer(peerId);
  updateConnLabel();
});

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

function renderChannels() {
  const textWrap = $('text-channels');
  const voiceWrap = $('voice-channels');
  textWrap.innerHTML = '';
  voiceWrap.innerHTML = '';

  for (const ch of state.channels) {
    const el = document.createElement('div');
    const missed = unreadMap.get(ch.id) || 0;
    el.className =
      'channel-item' +
      (ch.id === state.activeText ? ' active' : '') +
      (ch.type === 'text' && missed && ch.id !== state.activeText ? ' has-unread' : '');
    el.dataset.id = ch.id;

    const badge = missed && ch.id !== state.activeText
      ? `<span class="badge">${missed > 99 ? '99+' : missed}</span>`
      : '';
    const hint = ch.type === 'voice' ? '<span class="join-hint">Join</span>' : '';

    el.innerHTML =
      `<span class="ch-icon">${ch.type === 'voice' ? '&#127908;' : '#'}</span>` +
      `<span class="ch-name">${escapeHtml(ch.name)}</span>` +
      badge + hint;

    el.addEventListener('click', () => {
      if (ch.type === 'text') openChannel(ch.id);
      else joinVoice(ch.id);
    });

    if (ch.type === 'text') textWrap.appendChild(el);
    else {
      voiceWrap.appendChild(el);
      const members = state.participants.filter((p) => p.channel === ch.id);
      members.forEach((p) => {
        const u = document.createElement('div');
        u.className = 'voice-user' + (speakingSet.has(p.id) ? ' speaking' : '');
        u.dataset.id = p.id;
        u.innerHTML =
          `<span class="vu-dot" style="background:${p.color}"></span>` +
          `<span class="vu-name">${escapeHtml(p.name)}</span>` +
          `<span class="vu-flags">` +
          `${p.audio ? '' : '<span class="off">&#128263;</span>'}` +
          `${p.screen ? ' &#128247;' : ''}` +
          `</span>`;
        voiceWrap.appendChild(u);
      });
    }
  }
}

function renderVoiceParticipants() { renderChannels(); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Text chat                                                           */
/* ------------------------------------------------------------------ */

function openChannel(id) {
  const ch = channelById(id);
  if (!ch || ch.type !== 'text') return;
  state.activeText = id;
  unreadMap.delete(id); // reading it clears the unread pill
  typingMap.forEach((t) => clearTimeout(t.timeout));
  typingMap.clear();
  renderTyping();
  renderChannels();
  $('channel-title').textContent = ch.name;
  $('channel-topic').textContent = ch.topic || '';
  $('message-input').placeholder = `Message #${ch.name}`;
  $('messages').innerHTML = '';
  clearFilter();
  socket.emit('text:open', { channelId: id });
}

let lastDayShown = null;

function ensureDayDivider(wrap, ts) {
  const day = new Date(ts).toDateString();
  if (day === lastDayShown) return;
  lastDayShown = day;
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.textContent = fmtDay(ts);
  wrap.appendChild(div);
}

function renderHistory(messages) {
  const wrap = $('messages');
  wrap.innerHTML = '';
  lastDayShown = null;

  // welcome hero, like the top of a fresh Discord channel
  const ch = channelById(state.activeText);
  if (ch) {
    const people = state.users.length;
    const human = people > 1
      ? `${people} people are hanging out here right now.`
      : `It's just you here right now — invite a friend?`;
    const hero = document.createElement('div');
    hero.className = 'msg-hero';
    hero.innerHTML =
      `<div class="hero-icon">#</div>` +
      `<h2>Welcome to #${escapeHtml(ch.name)}!</h2>` +
      `<p class="hero-topic">${ch.topic ? escapeHtml(ch.topic) + ' — ' : ''}${human}</p>` +
      (messages.length ? '' : `<p class="hero-quiet">It's quiet in here. Be the first to say hi 👋</p>`);
    wrap.appendChild(hero);
  }

  let last = null;
  for (const msg of messages) {
    ensureDayDivider(wrap, msg.ts);
    const node = buildMessage(msg, last);
    wrap.appendChild(node);
    last = msg;
  }
  atBottom = true;
  missedWhileAway = 0;
  hideJump();
  applyFilter();
  scrollBottom();
}

function appendMessage(msg) {
  const wrap = $('messages');
  const nodes = wrap.querySelectorAll('.msg-group');
  let last = null;
  const candidates = [...nodes].filter((n) => n.dataset.userId === msg.userId && n.dataset.ts);
  if (candidates.length) {
    const prev = candidates[candidates.length - 1];
    last = { userId: prev.dataset.userId, ts: Number(prev.dataset.ts), name: prev.dataset.author };
  }

  const prevDay = lastDayShown;
  ensureDayDivider(wrap, msg.ts);
  if (lastDayShown !== prevDay) last = null; // don't group across a day divider

  const node = buildMessage(msg, last);
  wrap.appendChild(node);
  applyFilter();

  if (atBottom) {
    scrollBottom();
  } else {
    // user is reading older messages — count them and offer a jump button
    missedWhileAway += 1;
    showJump();
  }
}

function buildMessage(msg, last) {
  const grouped =
    last && last.userId === msg.userId && msg.ts - last.ts < 5 * 60 * 1000;
  const el = document.createElement('div');
  el.className = 'msg-group' + (grouped ? ' cont' : '');
  el.dataset.id = msg.id;
  el.dataset.userId = msg.userId;
  el.dataset.ts = msg.ts;
  el.dataset.author = msg.name;
  el.dataset.text = String(msg.text).toLowerCase();

  // Discord-style gutter timestamp, revealed when hovering a grouped message
  const hoverTime = grouped
    ? `<div class="msg-hover-time">${fmtTime(msg.ts)}</div>`
    : '';
  const avatar = `<div class="msg-avatar" style="background:${gradientFor(msg.color)}">${initial(msg.name)}</div>`;
  const meta = `<div class="msg-meta"><span class="msg-author">${escapeHtml(msg.name)}</span>` +
    `<span class="msg-time">${fmtFull(msg.ts)}</span></div>`;
  const text = `<div class="msg-text">${escapeHtml(msg.text)}</div>`;

  el.innerHTML =
    `${hoverTime}${avatar}` +
    `<div class="msg-body">${meta}${text}${reactionsHtml(msg.reactions)}</div>` +
    reactionsBarHtml;
  if (grouped) el.classList.add('cont');
  return el;
}

function scrollBottom() {
  const wrap = $('messages');
  wrap.scrollTop = wrap.scrollHeight;
}

/* ---- scroll state: only auto-scroll when already at the bottom ---- */
let atBottom = true;
let missedWhileAway = 0;

function showJump() {
  const btn = $('jump-btn');
  btn.textContent = missedWhileAway > 0 ? `\u2193 ${missedWhileAway > 99 ? '99+' : missedWhileAway}` : '\u2193';
  btn.classList.remove('hidden');
}
function hideJump() { $('jump-btn').classList.add('hidden'); }

$('messages').addEventListener('scroll', () => {
  const wrap = $('messages');
  const near = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 64;
  atBottom = near;
  if (near) {
    missedWhileAway = 0;
    hideJump();
  }
});

$('jump-btn').addEventListener('click', () => {
  const wrap = $('messages');
  wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  missedWhileAway = 0;
  atBottom = true;
  hideJump();
});

/* ---- message search / filter (client-side, per channel) ---- */
let filterText = '';

function applyFilter() {
  const q = filterText;
  const groups = document.querySelectorAll('#messages .msg-group');
  let matches = 0;
  groups.forEach((n) => {
    const hit = !q || (n.dataset.text || '').includes(q);
    n.classList.toggle('filtered-out', !hit);
    if (q && hit) matches += 1;
  });
  document
    .querySelectorAll('#messages .day-divider, #messages .msg-hero')
    .forEach((n) => n.classList.toggle('filtered-out', !!q));

  const bar = $('filter-bar');
  if (q) {
    bar.classList.remove('hidden');
    $('filter-text').textContent =
      matches === 0 ? `No messages matching “${q}”.`
        : `${matches} match${matches === 1 ? '' : 'es'} for “${q}”.`;
  } else {
    bar.classList.add('hidden');
  }
}

function clearFilter() {
  filterText = '';
  const input = $('search-input');
  if (input && input.value) input.value = '';
  applyFilter();
}

$('search-input').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  applyFilter();
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { clearFilter(); e.target.blur(); }
});
$('filter-clear').addEventListener('click', () => { clearFilter(); $('search-input').focus(); });

function renderTyping() {
  const names = [...typingMap.values()].map((t) => t.name);
  if (!names.length) return ($('typing-indicator').innerHTML = '');
  const label =
    names.length === 1
      ? `<b>${escapeHtml(names[0])}</b> is typing…`
      : `<b>${escapeHtml(names.slice(0, 3).join(', '))}</b> are typing…`;
  $('typing-indicator').innerHTML =
    `<span class="typing-dots"><i></i><i></i><i></i></span>${label}`;
}

/* composer */
let lastTypedAt = 0;
$('message-input').addEventListener('input', () => {
  if (!state.activeText) return;
  const now = Date.now();
  if (now - lastTypedAt > 2500) {
    lastTypedAt = now;
    socket.emit('typing', { channelId: state.activeText });
  }
});

$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

$('send-btn').addEventListener('click', sendMessage);

function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text || !state.activeText) return;
  socket.emit('text:send', { channelId: state.activeText, text });
  input.value = '';
  input.focus();
}

/* emoji picker */
const emojiPicker = $('emoji-picker');
EMOJIS.forEach((e) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = e;
  b.addEventListener('click', () => {
    const input = $('message-input');
    input.value += e;
    input.focus();
  });
  emojiPicker.appendChild(b);
});

$('emoji-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== $('emoji-btn')) {
    emojiPicker.classList.add('hidden');
  }
});

/* reactions: hover bar + existing chips (delegated so re-renders just work) */
$('messages').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-emoji]');
  if (!btn || !state.activeText) return;
  const group = btn.closest('.msg-group');
  if (!group || !group.dataset.id) return;
  socket.emit('text:react', {
    channelId: state.activeText,
    messageId: Number(group.dataset.id),
    emoji: btn.dataset.emoji,
  });
});

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

function renderMembers() {
  const list = $('member-list');
  if (!list) return;
  list.innerHTML = '';
  const inVoice = new Set(state.participants.map((p) => p.id));
  const sorted = [...state.users].sort((a, b) => Number(inVoice.has(b.id)) - Number(inVoice.has(a.id)) || a.name.localeCompare(b.name));
  $('member-count').textContent = sorted.length;

  const label = document.createElement('div');
  label.className = 'group-label';
  label.textContent = `Online — ${sorted.length}`;
  list.appendChild(label);

  for (const u of sorted) {
    const el = document.createElement('div');
    const isMe = u.id === socket.id;
    el.className =
      'member' +
      (inVoice.has(u.id) ? ' in-voice' : '') +
      (speakingSet.has(u.id) ? ' speaking' : '') +
      (isMe ? ' me' : '');
    el.dataset.id = u.id;
    el.innerHTML =
      `<div class="member-avatar" style="background:${gradientFor(u.color)}">${initial(u.name)}` +
      `<span class="status-dot"></span></div>` +
      `<div class="member-name">${escapeHtml(u.name)}${isMe ? '<span class="you-badge">you</span>' : ''}</div>` +
      (inVoice.has(u.id) ? `<div class="member-voice-tag"><span class="voice-dot"></span> Voice</div>` : '');
    list.appendChild(el);
  }
}

/* ------------------------------------------------------------------ */
/* Create channel modal                                                */
/* ------------------------------------------------------------------ */

let createType = 'text';

function openCreateModal() {
  $('create-overlay').classList.remove('hidden');
  $('channel-name-input').value = '';
  setTimeout(() => $('channel-name-input').focus(), 50);
}
function closeCreateModal() { $('create-overlay').classList.add('hidden'); }

$('add-channel-btn').addEventListener('click', openCreateModal);
$('add-channel-btn-2').addEventListener('click', openCreateModal);
$('create-cancel').addEventListener('click', closeCreateModal);
$('create-overlay').addEventListener('click', (e) => { if (e.target === $('create-overlay')) closeCreateModal(); });

document.querySelectorAll('.type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    createType = btn.dataset.type;
  });
});

function submitCreate() {
  const name = $('channel-name-input').value;
  if (!name.trim()) return;
  socket.emit('channel:create', { name, type: createType });
  closeCreateModal();
}
$('create-btn').addEventListener('click', submitCreate);
$('channel-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreate(); });

/* ------------------------------------------------------------------ */
/* Speaking detection: Web Audio analyser → "speaking" highlight       */
/* Purely cosmetic — wrapped so it can never break a call.             */
/* ------------------------------------------------------------------ */

const SPEAK_THRESHOLD = 0.03;   // peak amplitude that counts as talking
const SPEAK_ON_MS = 90;         // must be loud this long before highlighting
const SPEAK_OFF_MS = 320;       // must be quiet this long before clearing

const audioMonitors = new Map(); // id -> { src, analyser, buf, on, hotSince, coldSince }
let audioMonitorTimer = null;
let audioCtxRef = null;
let cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
if (window.CSS && typeof CSS.escape === 'function') cssEsc = CSS.escape;

function ensureAudioContext() {
  if (!audioCtxRef) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { audioCtxRef = new Ctx(); } catch (_) { return null; }
  }
  if (audioCtxRef.state === 'suspended') audioCtxRef.resume().catch(() => {});
  return audioCtxRef;
}

function monitorStream(id, stream) {
  if (!id || !stream || audioMonitors.has(id)) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    audioMonitors.set(id, {
      src, analyser,
      buf: new Float32Array(analyser.fftSize),
      on: false, hotSince: 0, coldSince: 0,
    });
    if (!audioMonitorTimer) audioMonitorTimer = setInterval(audioMonitorTick, 120);
  } catch (_) { /* cosmetic feature only */ }
}

function audioMonitorTick() {
  if (!audioMonitors.size) { stopAudioMonitors(); return; }
  const now = Date.now();
  for (const [id, m] of audioMonitors) {
    let peak = 0;
    try {
      m.analyser.getFloatTimeDomainData(m.buf);
      for (let i = 0; i < m.buf.length; i++) {
        const v = Math.abs(m.buf[i]);
        if (v > peak) peak = v;
      }
    } catch (_) { continue; }

    if (peak >= SPEAK_THRESHOLD) {
      m.coldSince = 0;
      if (!m.hotSince) m.hotSince = now;
      if (!m.on && now - m.hotSince >= SPEAK_ON_MS) setSpeaking(id, true);
    } else {
      m.hotSince = 0;
      if (!m.coldSince) m.coldSince = now;
      if (m.on && now - m.coldSince >= SPEAK_OFF_MS) setSpeaking(id, false);
    }
  }
}

function setSpeaking(id, on) {
  const m = audioMonitors.get(id);
  if (m) {
    if (m.on === on) return;
    m.on = on;
  }
  if (on) speakingSet.add(id); else speakingSet.delete(id);

  const esc = cssEsc(id);
  const tile = document.querySelector(`.tile[data-id="${esc}"]`);
  if (tile) tile.classList.toggle('speaking', on);
  const vu = document.querySelector(`.voice-user[data-id="${esc}"]`);
  if (vu) vu.classList.toggle('speaking', on);
  const member = document.querySelector(`.member[data-id="${esc}"]`);
  if (member) member.classList.toggle('speaking', on);
}

function removeMonitor(id) {
  const m = audioMonitors.get(id);
  if (m) {
    try { m.src.disconnect(); } catch (_) {}
    audioMonitors.delete(id);
  }
  if (speakingSet.has(id)) setSpeaking(id, false);
}

function stopAudioMonitors() {
  for (const m of audioMonitors.values()) { try { m.src.disconnect(); } catch (_) {} }
  audioMonitors.clear();
  speakingSet.clear();
  if (audioMonitorTimer) { clearInterval(audioMonitorTimer); audioMonitorTimer = null; }
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
}

/* ------------------------------------------------------------------ */
/* Voice / video                                                       */
/* ------------------------------------------------------------------ */

function activeVideoTrack() {
  return (
    (voice.screenStream && voice.screenStream.getVideoTracks()[0]) ||
    (voice.camStream && voice.camStream.getVideoTracks()[0]) ||
    null
  );
}

async function joinVoice(channelId) {
  if (voice.channel === channelId) return;
  if (voice.channel) leaveVoice();

  const ch = channelById(channelId);
  if (!ch) return;
  voice.channel = channelId;

  // make sure we have fresh STUN/TURN servers before gathering ICE candidates
  await Promise.race([
    refreshIceConfig(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);

  $('voice-panel').classList.remove('hidden');
  $('voice-channel-label').textContent = ch.name;
  $('video-grid').innerHTML = '';
  renderLocalTile();
  updateTilesFromState();

  try {
    voice.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    voice.localStream = null;
    toast('No mic? No problem — you joined in listen-only mode.');
  }
  if (voice.localStream) monitorStream(socket.id, voice.localStream);

  socket.emit('voice:join', { channelId });
  updateControls();
  renderVoiceParticipants();
}

function leaveVoice(silent) {
  // close all peer connections
  for (const id of [...voice.peers.keys()]) removePeer(id);

  // stop local media
  [voice.localStream, voice.camStream, voice.screenStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  voice.localStream = null;
  voice.camStream = null;
  voice.screenStream = null;
  voice.cameraOn = false;
  voice.screenOn = false;
  voice.muted = false;
  voice.deafened = false;

  const wasChannel = voice.channel;
  voice.channel = null;
  $('video-grid').innerHTML = '';
  $('voice-panel').classList.add('hidden');
  $('voice-panel').classList.remove('expanded');
  document.querySelector('.main').classList.remove('voice-expanded');
  $('btn-expand').textContent = '\u26f6';
  $('btn-expand').title = 'Maximize call';
  stopAudioMonitors();
  if (wasChannel && !silent) socket.emit('voice:leave');
  updateControls();
  renderVoiceParticipants();
}

function removePeer(peerId) {
  const p = voice.peers.get(peerId);
  if (!p) return;
  try { p.pc.close(); } catch (_) {}
  voice.peers.delete(peerId);
  removeMonitor(peerId);
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(peerId)}"]`);
  if (tile) tile.remove();
  layoutGrid();
}

function createPeer(peerId, meta, initiator) {
  let p = voice.peers.get(peerId);
  if (p) return p;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  p = {
    pc,
    name: meta?.name || 'Peer',
    color: meta?.color || '#5865f2',
    polite: String(socket.id) < String(peerId),
    makingOffer: false,
    ignoreOffer: false,
    pending: Promise.resolve(),
    connected: false,
  };
  voice.peers.set(peerId, p);

  if (voice.localStream) {
    voice.localStream.getAudioTracks().forEach((t) => pc.addTrack(t, voice.localStream));
  }
  const vt = activeVideoTrack();
  if (vt) pc.addTrack(vt, voice.camStream || voice.screenStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice:signal', {
        to: peerId,
        data: { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate },
      });
    }
  };

  pc.ontrack = (e) => {
    const tile = ensureTile(peerId, p.name, p.color);
    const video = tile.querySelector('video');
    video.srcObject = e.streams[0];
    video.muted = voice.deafened;
    video.play().catch(() => {});
    // ring their tile/sidebar row while they talk
    if (e.track && e.track.kind === 'audio' && e.streams[0] && e.streams[0].getAudioTracks().length) {
      monitorStream(peerId, e.streams[0]);
    }
  };

  pc.onnegotiationneeded = () => negotiate(p, peerId);

  pc.onconnectionstatechange = () => {
    p.connected = pc.connectionState === 'connected';
    updateConnLabel();
    const badge = document.querySelector(`.tile[data-id="${peerId}"] .tile-badge`);
    if (badge) badge.style.display = p.connected ? 'none' : 'block';
    if (['failed', 'closed'].includes(pc.connectionState)) {
      // keep tile, ICE may recover via restart; show state only
    }
  };

  ensureTile(peerId, p.name, p.color);
  // The joiner always starts the handshake (also covers listen-only peers
  // that have no local tracks and would otherwise never fire negotiationneeded).
  if (initiator) negotiate(p, peerId);
  updateConnLabel();
  return p;
}

async function negotiate(p, peerId) {
  if (p.pc.signalingState !== 'stable' || p.makingOffer) return;
  try {
    p.makingOffer = true;
    await p.pc.setLocalDescription();
    socket.emit('voice:signal', {
      to: peerId,
      data: { description: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } },
    });
  } catch (err) {
    console.warn('negotiation failed', err);
  } finally {
    p.makingOffer = false;
  }
}

function handleSignal(from, data) {
  const existing = voice.peers.get(from);
  const p = existing || createPeer(from, participantById(from), false);

  p.pending = p.pending.then(() => processSignal(p, from, data)).catch((err) => console.warn('signal error', err));
}

async function processSignal(p, from, data) {
  if (data.description) {
    const desc = data.description;
    const collision = desc.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
    p.ignoreOffer = !p.polite && collision;
    if (p.ignoreOffer) return; // impolite peer ignores colliding offer

    await p.pc.setRemoteDescription(desc);
    if (desc.type === 'offer') {
      await p.pc.setLocalDescription();
      socket.emit('voice:signal', {
        to: from,
        data: { description: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } },
      });
    }
  } else if (data.candidate) {
    try {
      await p.pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!p.ignoreOffer) console.warn('ICE error', err);
    }
  }
}

/* ---------------- media toggles ---------------- */

async function toggleMute() {
  if (!voice.channel) return;
  voice.muted = !voice.muted;
  const t = voice.localStream && voice.localStream.getAudioTracks()[0];
  if (t) t.enabled = !voice.muted;
  socket.emit('voice:state', { audio: !voice.muted });
  updateControls();
}

function toggleDeafen() {
  if (!voice.channel) return;
  voice.deafened = !voice.deafened;
  if (voice.deafened && !voice.muted) toggleMute();
  document.querySelectorAll('.tile video').forEach((v) => {
    if (!v.closest('.tile').dataset.me) v.muted = voice.deafened;
  });
  updateControls();
}

async function toggleCamera() {
  if (!voice.channel) return;
  if (voice.cameraOn) {
    if (voice.camStream) voice.camStream.getTracks().forEach((t) => t.stop());
    voice.camStream = null;
    voice.cameraOn = false;
    await applyVideoTrack();
    socket.emit('voice:state', { video: false });
    updateControls();
    return;
  }
  try {
    voice.camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    voice.cameraOn = true;
    await applyVideoTrack();
    socket.emit('voice:state', { video: true });
    updateControls();
    updateTilesFromState();
  } catch (err) {
    toast("Couldn't reach your camera — check permissions?", 'error');
  }
}

async function toggleScreen() {
  if (!voice.channel) return;
  if (voice.screenOn) return stopScreen();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    voice.screenStream = s;
    voice.screenOn = true;
    s.getVideoTracks()[0].addEventListener('ended', () => stopScreen());
    await applyVideoTrack();
    socket.emit('voice:state', { screen: true });
    updateControls();
    updateTilesFromState();
  } catch (err) {
    if (err && err.name !== 'NotAllowedError') toast("Screen share didn't start — want to try again?", 'error');
  }
}

function stopScreen() {
  if (voice.screenStream) voice.screenStream.getTracks().forEach((t) => t.stop());
  voice.screenStream = null;
  voice.screenOn = false;
  applyVideoTrack();
  socket.emit('voice:state', { screen: false });
  updateControls();
  updateTilesFromState();
}

async function applyVideoTrack() {
  const track = activeVideoTrack();

  // update local preview
  const localTile = document.querySelector('.tile[data-me]');
  if (localTile) {
    const video = localTile.querySelector('video');
    const stream = voice.screenStream || voice.camStream;
    if (stream && track) {
      video.srcObject = stream;
      video.classList.toggle('mirrored', !voice.screenOn);
      video.play().catch(() => {});
      video.style.opacity = '1';
    } else {
      video.srcObject = null;
      video.style.opacity = '0';
    }
  }

  // propagate to every peer
  for (const [peerId, p] of voice.peers.entries()) {
    try {
      const videoTransceiver = p.pc
        .getTransceivers()
        .find((t) => t.receiver.track && t.receiver.track.kind === 'video');

      if (videoTransceiver) {
        await videoTransceiver.sender.replaceTrack(track);
        // make sure the m-line actually sends (a no-track answer can be recvonly)
        if (track && videoTransceiver.direction !== 'sendrecv') {
          videoTransceiver.direction = 'sendrecv';
        }
      } else if (track) {
        p.pc.addTrack(track, voice.camStream || voice.screenStream);
      }
      // guarantee the SDP reflects the new media state
      await negotiate(p, peerId);
    } catch (err) {
      console.warn('replaceTrack failed', err);
    }
  }
  updateTilesFromState();
}

function updateControls() {
  const inVoice = !!voice.channel;
  $('btn-mute').classList.toggle('active', voice.muted);
  $('btn-camera').classList.toggle('off', !voice.cameraOn);
  $('btn-camera').title = voice.cameraOn ? 'Turn camera off' : 'Turn camera on';
  $('btn-screen').classList.toggle('active', voice.screenOn);
  $('panel-mute').classList.toggle('active', voice.muted && inVoice);
  $('panel-deafen').classList.toggle('active', voice.deafened && inVoice);
  $('panel-mute').style.opacity = inVoice ? '1' : '.45';
  $('panel-deafen').style.opacity = inVoice ? '1' : '.45';
}

$('btn-mute').addEventListener('click', toggleMute);
$('btn-camera').addEventListener('click', toggleCamera);
$('btn-screen').addEventListener('click', toggleScreen);
$('btn-leave').addEventListener('click', () => leaveVoice());
$('panel-mute').addEventListener('click', toggleMute);
$('panel-deafen').addEventListener('click', toggleDeafen);

/* maximize the call panel (hides chat until restored) */
$('btn-expand').addEventListener('click', () => {
  const panel = $('voice-panel');
  const on = panel.classList.toggle('expanded');
  document.querySelector('.main').classList.toggle('voice-expanded', on);
  $('btn-expand').textContent = on ? '\u25a9' : '\u26f6';
  $('btn-expand').title = on ? 'Show chat' : 'Maximize call';
  $('btn-expand').classList.toggle('active', false);
});

/* toggle the right-hand member list (desktop only) */
$('toggle-members').addEventListener('click', () => {
  const app = document.querySelector('.app');
  const hidden = app.classList.toggle('members-hidden');
  try { localStorage.setItem('sold-members-hidden', hidden ? '1' : '0'); } catch (_) {}
  $('toggle-members').classList.toggle('on', !hidden);
});
try {
  if (localStorage.getItem('sold-members-hidden') === '1') {
    document.querySelector('.app').classList.add('members-hidden');
    $('toggle-members').classList.remove('on');
  }
} catch (_) {}

/* send button lights up once there is something to send */
$('message-input').addEventListener('input', () => {
  $('send-btn').classList.toggle('ready', $('message-input').value.trim().length > 0);
});

function updateConnLabel() {
  const el = $('voice-conn');
  if (!voice.channel) return;
  const total = state.participants.filter((p) => p.channel === voice.channel).length;
  const connected = [...voice.peers.values()].filter((p) => p.connected).length;
  if (!voice.peers.size) el.textContent = `You are in — ${total === 1 ? 'just you' : `waiting for ${total - 1} more`}`;
  else if (connected === voice.peers.size) el.textContent = `Connected — ${connected + 1} ${connected === 0 ? 'person' : 'people'}`;
  else el.textContent = `Connecting… ${connected}/${voice.peers.size} ready`;
}

/* ---------------- tiles ---------------- */

function ensureTile(id, name, color) {
  let tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (tile) {
    tile.dataset.name = name;
    return tile;
  }
  tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = id;
  tile.dataset.name = name;
  tile.innerHTML =
    `<video autoplay playsinline style="opacity:0"></video>` +
    `<div class="tile-fallback"><div class="tf-avatar" style="background:${gradientFor(color)}">${initial(name)}</div></div>` +
    `<div class="tile-name">${escapeHtml(name)}</div>` +
    `<div class="tile-badge" style="display:none">connecting…</div>`;
  $('video-grid').appendChild(tile);
  layoutGrid();
  return tile;
}

function renderLocalTile() {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.me = '1';
  tile.dataset.id = 'me';
  tile.dataset.name = state.me ? state.me.name : 'You';
  tile.innerHTML =
    `<video autoplay playsinline muted class="mirrored" style="opacity:0"></video>` +
    `<div class="tile-fallback"><div class="tf-avatar" style="background:${gradientFor(state.me ? state.me.color : '#5865f2')}">` +
    `${initial(state.me && state.me.name)}</div></div>` +
    `<div class="tile-name">You</div>`;
  $('video-grid').appendChild(tile);
  if (voice.localStream) {
    const v = tile.querySelector('video');
    v.muted = true;
    v.play().catch(() => {});
  }
  layoutGrid();
}

function layoutGrid() {
  const grid = $('video-grid');
  const n = grid.children.length;
  if (n <= 1) grid.style.gridTemplateColumns = 'minmax(240px, 640px)';
  else if (n <= 4) grid.style.gridTemplateColumns = 'repeat(2, minmax(240px, 1fr))';
  else grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))';
}

function updateTilesFromState() {
  for (const p of state.participants) {
    if (p.channel !== voice.channel) continue;
    const tile = document.querySelector(`.tile[data-id="${CSS.escape(p.id)}"]`);
    if (!tile) continue;

    const nameEl = tile.querySelector('.tile-name');
    if (nameEl) {
      nameEl.innerHTML =
        `${escapeHtml(p.id === socket.id ? 'You' : p.name)}` +
        (p.audio ? '' : ' <span class="muted-ico">&#128263;</span>') +
        (p.screen ? ' &#128247;' : '');
    }

    const fallback = tile.querySelector('.tile-fallback');
    const video = tile.querySelector('video');
    const isSelf = tile.dataset.me === '1';
    const stream = isSelf ? (voice.screenStream || voice.camStream) : null;
    const showing = isSelf ? !!(stream && activeVideoTrack()) : (p.screen || p.video);
    if (fallback) fallback.style.display = showing ? 'none' : 'flex';
    if (video) video.style.opacity = showing ? '1' : '0';

    if (!isSelf) {
      video.muted = voice.deafened;
      tile.title = `${p.name} — ${p.screen ? 'screen sharing' : p.video ? 'camera on' : 'camera off'}`;
    }
  }

  // participants who should have a tile but don't (e.g. re-render)
  if (voice.channel) {
    state.participants
      .filter((p) => p.channel === voice.channel && p.id !== socket.id)
      .forEach((p) => ensureTile(p.id, p.name, p.color));
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCreateModal();
    emojiPicker.classList.add('hidden');
  }
});

// pre-fill the username field from the last successful sign-in
try {
  const lastUser = localStorage.getItem('sold-username');
  if (lastUser) $('auth-username').value = lastUser;
} catch (_) {}
setAuthMode('login');
updateControls();
