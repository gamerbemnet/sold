const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

app.set('trust proxy', true); // real client IP behind the cloudflared tunnel
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4kb' }));

/* ------------------------------------------------------------------ */
/* TURN credentials                                                     */
/* Cloudflare's public speed-test TURN (global relay network, free).   */
/* The upstream endpoint only answers requests that carry its own      */
/* Referer, so browsers fetch credentials from us instead.             */
/* ------------------------------------------------------------------ */

const TURN_UPSTREAM = 'https://speed.cloudflare.com/turn-creds';
const TURN_UPSTREAM_HEADERS = {
  Referer: 'https://speed.cloudflare.com/',
  Origin: 'https://speed.cloudflare.com',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};
const TURN_REFRESH_MS = 8 * 60 * 1000; // credentials are short-lived
let turnCache = { at: 0, data: null, lastError: null };

async function getTurnCredentials() {
  if (turnCache.data && Date.now() - turnCache.at < TURN_REFRESH_MS) return turnCache.data;
  try {
    const res = await fetch(TURN_UPSTREAM, {
      headers: TURN_UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (!data || !data.username || !data.credential || !Array.isArray(data.urls)) {
      throw new Error('unexpected payload');
    }
    turnCache = { at: Date.now(), data, lastError: null };
    console.log('TURN credentials refreshed');
  } catch (err) {
    turnCache.lastError = err.message;
    console.warn('TURN credential refresh failed:', err.message);
  }
  return turnCache.data;
}

app.get('/api/turn', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = await getTurnCredentials();
  if (!data) {
    return res.status(503).json({ error: 'turn-unavailable', detail: turnCache.lastError });
  }
  res.json({
    urls: data.urls,
    username: data.username,
    credential: data.credential,
    expiresAt: turnCache.at + TURN_REFRESH_MS,
  });
});

// pre-warm so the first call doesn't wait
getTurnCredentials();
setInterval(getTurnCredentials, TURN_REFRESH_MS).unref();

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */

const CHANNELS = [
  { id: 't-general', name: 'general', type: 'text', topic: 'Talk about anything' },
  { id: 't-random', name: 'random', type: 'text', topic: 'Memes, links and off-topic' },
  { id: 't-help', name: 'help', type: 'text', topic: 'Ask for help here' },
  { id: 'v-lobby', name: 'Lobby', type: 'voice', topic: 'Hang out and chat' },
  { id: 'v-gaming', name: 'Gaming', type: 'voice', topic: 'Squad up' },
];

const MAX_HISTORY = 200;
const history = new Map();
for (const c of CHANNELS) if (c.type === 'text') history.set(c.id, []);

const users = new Map(); // socket.id -> user
const COLORS = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63', '#00bcd4',
];

let messageCounter = 0;

const channelById = (id) => CHANNELS.find((c) => c.id === id);

function publicUsers() {
  return [...users.values()].map((u) => ({
    id: u.id, name: u.name, color: u.color, voiceRoom: u.voiceRoom,
  }));
}

function voiceParticipants() {
  return [...users.values()]
    .filter((u) => u.voiceRoom)
    .map((u) => ({
      id: u.id,
      name: u.name,
      color: u.color,
      channel: u.voiceRoom,
      audio: u.audio,
      video: u.video,
      screen: u.screen,
    }));
}

function pushHistory(channelId, msg) {
  const list = history.get(channelId);
  if (!list) return;
  list.push(msg);
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
}

/* ------------------------------------------------------------------ */
/* Accounts & sessions                                                  */
/* Sign up / sign in over HTTP; the Socket.IO join carries the token.   */
/* Persisted to data/accounts.json so accounts survive restarts.       */
/* ------------------------------------------------------------------ */

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let accounts = new Map(); // lower(username) -> { username, salt, hash, color, createdAt }
let sessions = new Map(); // token -> { username, expiresAt }

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    accounts = new Map(Object.entries(data.accounts || {}));
    sessions = new Map(Object.entries(data.sessions || {}));
  } catch (_) {
    /* first run — no file yet */
  }
}

function saveAccounts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { accounts: Object.fromEntries(accounts), sessions: Object.fromEntries(sessions) },
        null,
        2
      )
    );
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (err) {
    console.warn('failed to persist accounts:', err.message);
  }
}
loadAccounts();

const USERNAME_RE = /^[a-z0-9_][a-z0-9_.-]{2,23}$/i;
const normalizeUsername = (v) => String(v || '').trim().slice(0, 24);

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, account) {
  const hash = Buffer.from(hashPassword(password, account.salt), 'hex');
  const stored = Buffer.from(account.hash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
  sessions.set(token, { username, expiresAt: now + SESSION_TTL_MS });
  saveAccounts();
  return token;
}

function sessionUser(token) {
  if (typeof token !== 'string' || token.length < 32) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    saveAccounts();
    return null;
  }
  return accounts.get(session.username.toLowerCase()) || null;
}

// light brute-force protection: 30 auth attempts / 10 min / IP
const authAttempts = new Map();
function authRateLimited(ip) {
  const now = Date.now();
  let entry = authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + 10 * 60 * 1000 };
    authAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count > 30;
}

const publicAccount = (a) => ({ username: a.username, color: a.color, createdAt: a.createdAt });

app.post('/api/signup', (req, res) => {
  if (authRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
  }
  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Usernames are 3–24 characters: letters, numbers, and _ . -',
    });
  }
  if (password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: 'Passwords need at least 6 characters.' });
  }
  const key = username.toLowerCase();
  if (accounts.has(key)) {
    return res.status(409).json({ error: "That name's already taken — try another?" });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    username,
    salt,
    hash: hashPassword(password, salt),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now(),
  };
  accounts.set(key, account);
  const token = createSession(username);
  console.log(`account created: ${username}`);
  res.json({ token, user: publicAccount(account) });
});

app.post('/api/login', (req, res) => {
  if (authRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
  }
  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  const account = accounts.get(username.toLowerCase());
  if (!account || !verifyPassword(password, account)) {
    return res.status(401).json({ error: "Hmm, that username or password doesn't look right." });
  }
  const token = createSession(account.username);
  res.json({ token, user: publicAccount(account) });
});

app.post('/api/logout', (req, res) => {
  const token = String((req.body && req.body.token) || '');
  if (sessions.has(token)) {
    sessions.delete(token);
    saveAccounts();
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Socket handling                                                     */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  socket.on('join', (payload = {}) => {
    if (users.has(socket.id)) return;

    const account = sessionUser(payload.token);
    if (!account) {
      socket.emit('join:error', { error: 'Looks like your session expired — please log in again.' });
      return;
    }

    let name = account.username.slice(0, 24);
    // de-duplicate names (same account open in two tabs)
    const taken = new Set([...users.values()].map((u) => u.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name} ${n}`.toLowerCase())) n++;
      name = `${name} ${n}`.slice(0, 24);
    }

    const user = {
      id: socket.id,
      name,
      color: account.color,
      voiceRoom: null,
      audio: true,
      video: false,
      screen: false,
    };
    users.set(socket.id, user);

    socket.emit('init', {
      me: { id: user.id, name: user.name, color: user.color },
      channels: CHANNELS,
      users: publicUsers(),
      voice: voiceParticipants(),
    });
    io.emit('users', publicUsers());
    io.emit('voice:update', voiceParticipants());
  });

  /* ---------------- text chat ---------------- */

  socket.on('text:open', ({ channelId } = {}) => {
    const ch = channelById(channelId);
    if (!ch || ch.type !== 'text') return;
    socket.emit('text:history', { channelId, messages: history.get(channelId) || [] });
  });

  socket.on('text:send', ({ channelId, text } = {}) => {
    const user = users.get(socket.id);
    const ch = channelById(channelId);
    if (!user || !ch || ch.type !== 'text') return;
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return;

    const msg = {
      id: ++messageCounter,
      channelId,
      userId: user.id,
      name: user.name,
      color: user.color,
      text,
      reactions: {},
      ts: Date.now(),
    };
    pushHistory(channelId, msg);
    io.emit('text:message', msg);
  });

  /* emoji reactions — toggle on/off, broadcast the fresh counts */
  const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '🎉', '😮', '🔥']);

  socket.on('text:react', ({ channelId, messageId, emoji } = {}) => {
    const user = users.get(socket.id);
    if (!user || !ALLOWED_REACTIONS.has(emoji)) return;
    const list = history.get(channelId);
    if (!list) return;
    const msg = list.find((m) => m.id === Number(messageId));
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    const voters = msg.reactions[emoji] || [];
    const i = voters.indexOf(user.id);
    if (i >= 0) voters.splice(i, 1);
    else voters.push(user.id);
    if (voters.length) msg.reactions[emoji] = voters;
    else delete msg.reactions[emoji];

    io.emit('text:reaction', { channelId, messageId: msg.id, reactions: msg.reactions });
  });

  socket.on('typing', ({ channelId } = {}) => {
    const user = users.get(socket.id);
    if (!user || !channelById(channelId)) return;
    socket.broadcast.emit('typing', { channelId, userId: user.id, name: user.name });
  });

  socket.on('channel:create', ({ name, type } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    name = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\- ]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 24);
    if (!name) return;
    if (CHANNELS.some((c) => c.name === name)) return;
    if (type !== 'voice') type = 'text';

    const id = `${type === 'voice' ? 'v' : 't'}-${Date.now().toString(36)}`;
    CHANNELS.push({ id, name, type, topic: type === 'voice' ? 'Voice channel' : 'Text channel' });
    if (type === 'text') history.set(id, []);
    io.emit('channels', CHANNELS);
  });

  /* ---------------- voice / video ---------------- */

  socket.on('voice:join', ({ channelId } = {}) => {
    const user = users.get(socket.id);
    const ch = channelById(channelId);
    if (!user || !ch || ch.type !== 'voice') return;
    if (user.voiceRoom === channelId) return;

    user.voiceRoom = channelId;
    user.audio = true;
    user.video = false;
    user.screen = false;

    const peers = voiceParticipants().filter((p) => p.id !== socket.id && p.channel === channelId);
    socket.emit('voice:peers', { channel: channelId, peers });
    io.emit('voice:update', voiceParticipants());
  });

  socket.on('voice:leave', () => {
    const user = users.get(socket.id);
    if (!user || !user.voiceRoom) return;
    user.voiceRoom = null;
    user.video = false;
    user.screen = false;
    socket.broadcast.emit('voice:leave', { peerId: socket.id });
    io.emit('voice:update', voiceParticipants());
  });

  socket.on('voice:state', (payload = {}) => {
    const user = users.get(socket.id);
    if (!user || !user.voiceRoom) return;
    if (typeof payload.audio === 'boolean') user.audio = payload.audio;
    if (typeof payload.video === 'boolean') user.video = payload.video;
    if (typeof payload.screen === 'boolean') user.screen = payload.screen;
    io.emit('voice:update', voiceParticipants());
  });

  socket.on('voice:signal', ({ to, data } = {}) => {
    if (!to || !data || !users.has(to)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  /* ---------------- disconnect ---------------- */

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    if (user.voiceRoom) {
      io.emit('voice:leave', { peerId: socket.id });
      io.emit('voice:update', voiceParticipants());
    }
    io.emit('users', publicUsers());
  });
});

server.listen(PORT, () => {
  console.log(`Sold running at http://localhost:${PORT}`);
});
