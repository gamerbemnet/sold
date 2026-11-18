const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.SOLD_DATA_DIR || path.join(__dirname, 'data');

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

/* ------------------------------------------------------------------ */
/* Servers (private groups) — each server owns its channels, its      */
/* member list and its invite code. Nothing is shared between servers. */
/* Persisted to servers.json; first run migrates the old global       */
/* channels into a single "Sold" server owned by the first account.   */
/* ------------------------------------------------------------------ */

const DEFAULT_CHANNEL_SEED = [
  { name: 'general', type: 'text', topic: 'Talk about anything' },
  { name: 'random', type: 'text', topic: 'Memes, links and off-topic' },
  { name: 'help', type: 'text', topic: 'Ask for help here' },
  { name: 'Lobby', type: 'voice', topic: 'Hang out and chat' },
  { name: 'Gaming', type: 'voice', topic: 'Squad up' },
];
const SERVER_COLORS = ['#ff7a59', '#c084fc', '#3ba55c', '#faa61a', '#eb459e', '#1abc9c', '#9b59b6', '#00bcd4'];
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const MAX_SERVERS_PER_USER = 12;
const MAX_CHANNELS_PER_SERVER = 60;

let servers = new Map();        // id -> server record
let channelsArr = [];           // channel records (seed order, then creation order)
const channelIndex = new Map(); // id -> channel record

const lower = (v) => String(v || '').toLowerCase();
const genInvite = () => crypto.randomBytes(4).toString('hex'); // 8 hex chars

function loadServers() {
  if (!fs.existsSync(SERVERS_FILE)) {
    // fresh instance — start empty, never auto-create a group
    console.log('no servers.json — starting with an empty store');
    saveServers();
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
    servers = new Map(Object.entries(data.servers || {}));
    channelsArr = Object.values(data.channels || {});
    channelIndex.clear();
    for (const c of channelsArr) channelIndex.set(c.id, c);
    console.log(`servers loaded: ${servers.size} server(s), ${channelsArr.length} channel(s)`);
  } catch (err) {
    console.warn('servers.json unreadable (' + err.message + ') — booting with empty servers');
  }
}

function saveServers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SERVERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(
      { servers: Object.fromEntries(servers), channels: Object.fromEntries(channelIndex) },
      null,
      2
    ));
    fs.renameSync(tmp, SERVERS_FILE);
  } catch (err) {
    console.warn('failed to persist servers:', err.message);
  }
}

const channelById = (id) => channelIndex.get(id);
const serversFor = (username) => [...servers.values()].filter((s) => s.members.includes(lower(username)));
const memberOfServer = (username, serverId) => {
  const s = servers.get(serverId);
  return !!s && s.members.includes(lower(username));
};
const sharedServer = (a, b) => {
  const asa = new Set(serversFor(a).map((s) => s.id));
  return serversFor(b).some((s) => asa.has(s.id));
};
const channelsForUser = (username) => {
  const mine = new Set(serversFor(username).map((s) => s.id));
  return channelsArr.filter((c) => mine.has(c.serverId));
};
const publicServer = (s) => ({ id: s.id, name: s.name, color: s.color, owner: s.owner, invite: s.invite, members: [...s.members], createdAt: s.createdAt });

const MAX_HISTORY = 200;
const history = new Map();

const users = new Map(); // socket.id -> user
const COLORS = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63', '#00bcd4',
];

let messageCounter = 0;

function voiceParticipants() {
  return [...users.values()]
    .filter((u) => u.voiceRoom)
    .map((u) => ({
      id: u.id,
      name: u.name,
      color: u.color,
      channel: u.voiceRoom,
      serverId: (channelById(u.voiceRoom) || {}).serverId || null,
      audio: u.audio,
      video: u.video,
      screen: u.screen,
    }));
}

function pushHistory(channelId, msg) {
  let list = history.get(channelId);
  if (!list && typeof channelId === 'string' && channelId.startsWith('dm:')) {
    list = [];
    history.set(channelId, list);
  }
  if (!list) return;
  list.push(msg);
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  if (channelId.startsWith('dm:')) saveDms();
}

/* ------------------------------------------------------------------ */
/* Friends — request/accept/decline, persisted; DMs ride the same      */
/* machinery. Visibility = shared servers ∪ friends.                    */
/* ------------------------------------------------------------------ */

const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');

let friendships = new Map();  // lower(username) -> Set(lower(username))
let friendRequests = new Map(); // lower(username) -> [{ from, ts }]

function loadFriends() {
  try {
    const data = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
    friendships = new Map(Object.entries(data.friendships || {}).map(([k, v]) => [k, new Set(v)]));
    friendRequests = new Map(Object.entries(data.requests || {}));
  } catch (_) { /* first run */ }
}

function saveFriends() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FRIENDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      friendships: Object.fromEntries([...friendships].map(([k, v]) => [k, [...v]])),
      requests: Object.fromEntries(friendRequests),
    }, null, 2));
    fs.renameSync(tmp, FRIENDS_FILE);
  } catch (err) {
    console.warn('failed to persist friends:', err.message);
  }
}

const lowerU = (v) => String(v || '').toLowerCase();
const areFriends = (a, b) => (friendships.get(lowerU(a)) || new Set()).has(lowerU(b));
const friendsListOf = (u) => [...(friendships.get(lowerU(u)) || new Set())];

function sharesSpace(a, b) {
  return sharedServer(a, b) || areFriends(a, b);
}

function onlineUsernames() {
  return new Set([...users.values()].map((u) => u.username));
}

function publicFriend(username, onlineSet) {
  const acc = accounts.get(lowerU(username));
  return {
    username: acc ? acc.username : username,
    color: acc ? acc.color : '#5865f2',
    online: onlineSet.has(lowerU(username)),
  };
}

function friendsPayloadFor(username) {
  const u = lowerU(username);
  const online = onlineUsernames();
  const friends = friendsListOf(u)
    .map((f) => publicFriend(f, online))
    .sort((x, y) => Number(y.online) - Number(x.online) || x.username.localeCompare(y.username));
  const incoming = (friendRequests.get(u) || []).map((r) => {
    const acc = accounts.get(r.from);
    return { username: acc ? acc.username : r.from, color: acc ? acc.color : '#5865f2', ts: r.ts };
  });
  const outgoing = [];
  for (const [to, list] of friendRequests) {
    for (const r of list) if (r.from === u) outgoing.push({ username: to, ts: r.ts });
  }
  return { friends, incoming, outgoing };
}

function setFriendship(a, b, on) {
  a = lowerU(a); b = lowerU(b);
  const add = (x, y) => { const s = new Set(friendships.get(x) || []); s.add(y); friendships.set(x, s); };
  const del = (x, y) => { const s = new Set(friendships.get(x) || []); s.delete(y); if (s.size) friendships.set(x, s); else friendships.delete(x); };
  if (on) { add(a, b); add(b, a); } else { del(a, b); del(b, a); }
}

function pushFriendsTo(username) {
  const key = lowerU(username);
  const payload = friendsPayloadFor(key);
  for (const [sid, u] of users) if (u.username === key) io.to(sid).emit('friends', payload);
}

function refreshFriendsPresence() {
  for (const [sid, u] of users) io.to(sid).emit('friends', friendsPayloadFor(u.username));
}

/* ---------------- DMs: threads ride the channel/history machinery --- */

const dmPair = (channelId) => {
  if (typeof channelId !== 'string' || !channelId.startsWith('dm:')) return null;
  const [a, b] = channelId.slice(3).split('::');
  if (!a || !b || a === b) return null;
  return [a, b];
};
const dmKey = (a, b) => `dm:${[lowerU(a), lowerU(b)].sort().join('::')}`;
const dmAuthorized = (channelId, username) => {
  const pair = dmPair(channelId);
  return !!pair && (pair[0] === username || pair[1] === username) && areFriends(pair[0], pair[1]);
};

function emitToDmPair(pair, event, payload, exceptSocketId) {
  for (const [sid, u] of users) {
    if (exceptSocketId && sid === exceptSocketId) continue;
    if (pair[0] === u.username || pair[1] === u.username) io.to(sid).emit(event, payload);
  }
}

function emitDmSummaries(pair) {
  for (const [sid, u] of users) {
    if (pair[0] === u.username || pair[1] === u.username) io.to(sid).emit('dms', dmSummariesFor(u.username));
  }
}

function pushDmsTo(username) {
  const key = lowerU(username);
  const payload = dmSummariesFor(key);
  for (const [sid, u] of users) if (u.username === key) io.to(sid).emit('dms', payload);
}

function saveDms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const threads = {};
    for (const [key, list] of history) if (key.startsWith('dm:')) threads[key] = list;
    const tmp = DMS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ threads }, null, 2));
    fs.renameSync(tmp, DMS_FILE);
  } catch (err) {
    console.warn('failed to persist DMs:', err.message);
  }
}

function loadDms() {
  try {
    const data = JSON.parse(fs.readFileSync(DMS_FILE, 'utf8'));
    for (const [key, list] of Object.entries(data.threads || {})) {
      if (dmPair(key)) history.set(key, Array.isArray(list) ? list : []);
    }
  } catch (_) { /* first run */ }
}

function dmSummariesFor(username) {
  const u = lowerU(username);
  const online = onlineUsernames();
  const out = [];
  for (const [key, list] of history) {
    if (!key.startsWith('dm:')) continue;
    const pair = dmPair(key);
    if (!pair || (pair[0] !== u && pair[1] !== u)) continue;
    const other = pair[0] === u ? pair[1] : pair[0];
    if (!areFriends(u, other)) continue; // unfriended → thread disappears
    const acc = accounts.get(other);
    const last = list[list.length - 1];
    out.push({
      key, with: other,
      name: acc ? acc.username : other,
      color: acc ? acc.color : '#5865f2',
      online: online.has(other),
      last: last ? { text: last.text, ts: last.ts, from: lowerU(last.name) === u ? 'me' : other } : null,
    });
  }
  return out.sort((x, y) => ((y.last && y.last.ts) || 0) - ((x.last && x.last.ts) || 0));
}

/* member-scoped delivery — nothing crosses a server boundary */
function scopedUsersFor(u) {
  return [...users.values()]
    .filter((o) => sharesSpace(o.username, u.username))
    .map((o) => ({
      id: o.id, name: o.name, color: o.color, voiceRoom: o.voiceRoom,
      servers: serversFor(o.username).map((s) => s.id),
    }));
}
function scopedVoiceFor(u) {
  return voiceParticipants().filter((p) => p.serverId && memberOfServer(u.username, p.serverId));
}
function emitToServerMembers(serverId, event, payload, exceptSocketId) {
  for (const [sid, member] of users) {
    if (exceptSocketId && sid === exceptSocketId) continue;
    if (memberOfServer(member.username, serverId)) io.to(sid).emit(event, payload);
  }
}
function pushChannels(socketId) {
  const u = users.get(socketId);
  if (!u) return;
  io.to(socketId).emit('channels', channelsForUser(u.username));
}
function pushChannelsToServer(serverId) {
  for (const [sid, member] of users) {
    if (memberOfServer(member.username, serverId)) pushChannels(sid);
  }
}
function pushUserLists() {
  for (const [sid, u] of users) io.to(sid).emit('users', scopedUsersFor(u));
}
function pushVoiceLists() {
  for (const [sid, u] of users) io.to(sid).emit('voice:update', scopedVoiceFor(u));
}
function initFor(u) {
  return {
    me: { id: u.id, name: u.name, color: u.color, username: lowerU(u.username) },
    servers: serversFor(u.username).map(publicServer),
    channels: channelsForUser(u.username),
    users: scopedUsersFor(u),
    voice: scopedVoiceFor(u),
    dms: dmSummariesFor(u.username),
  };
}

/* ------------------------------------------------------------------ */
/* Accounts & sessions                                                  */
/* Sign up / sign in over HTTP; the Socket.IO join carries the token.   */
/* Persisted to data/accounts.json so accounts survive restarts.       */
/* ------------------------------------------------------------------ */

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
loadServers();
for (const c of channelsArr) if (c.type === 'text') history.set(c.id, []);
loadFriends();
loadDms();

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
/* Servers — create / join by invite / leave (HTTP, token-carrying)    */
/* ------------------------------------------------------------------ */

function reinitUser(username) {
  const key = lower(username);
  for (const [sid, u] of users) {
    if (u.username === key) io.to(sid).emit('init', initFor(u));
  }
}

function tokenAccount(req, res) {
  const account = sessionUser(String((req.body && req.body.token) || ''));
  if (!account) res.status(401).json({ error: 'Please log in again.' });
  return account;
}

app.post('/api/servers/create', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  if (name.length < 2) return res.status(400).json({ error: 'Give your server a name (2+ characters).' });
  const me = lower(account.username);
  if (serversFor(me).length >= MAX_SERVERS_PER_USER) {
    return res.status(400).json({ error: `You can be in at most ${MAX_SERVERS_PER_USER} servers.` });
  }
  const id = 'srv-' + crypto.randomBytes(6).toString('hex');
  const rec = {
    id, name, owner: me,
    color: SERVER_COLORS[crypto.randomInt(SERVER_COLORS.length)],
    invite: genInvite(), members: [me], createdAt: Date.now(),
  };
  servers.set(id, rec);
  for (const seed of DEFAULT_CHANNEL_SEED) {
    const chan = {
      id: `${seed.type === 'voice' ? 'v' : 't'}-${Date.now().toString(36)}-${crypto.randomInt(0xffff)}`,
      serverId: id, ...seed,
    };
    channelsArr.push(chan);
    channelIndex.set(chan.id, chan);
    if (chan.type === 'text') history.set(chan.id, []);
  }
  saveServers();
  reinitUser(me);
  console.log(`server created: ${name} (${id}) by ${me}`);
  res.json({ server: publicServer(rec) });
});

app.post('/api/servers/join', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const code = lower(String((req.body && req.body.invite) || '').trim());
  if (!code) return res.status(400).json({ error: 'Enter an invite code.' });
  const target = [...servers.values()].find((s) => lower(s.invite) === code);
  if (!target) return res.status(404).json({ error: "That invite doesn't match any server — double-check the code?" });
  const me = lower(account.username);
  if (target.members.length >= 100) return res.status(400).json({ error: 'That server is full.' });
  if (!target.members.includes(me)) {
    target.members.push(me);
    saveServers();
    console.log(`server joined: ${target.name} (${target.id}) by ${me}`);
  }
  pushChannelsToServer(target.id);
  pushUserLists();
  pushVoiceLists();
  reinitUser(me);
  res.json({ server: publicServer(target) });
});

/* ------------------------------------------------------------------ */
/* Friends — request / accept / decline / remove, over HTTP             */
/* ------------------------------------------------------------------ */

function addFriendRequest(from, to) {
  const list = friendRequests.get(to) || [];
  if (list.some((r) => r.from === from)) return false;
  friendRequests.set(to, [...list, { from, ts: Date.now() }]);
  return true;
}
function removeFriendRequest(from, to) {
  const list = friendRequests.get(to) || [];
  const next = list.filter((r) => r.from !== from);
  if (next.length) friendRequests.set(to, next); else friendRequests.delete(to);
}

app.post('/api/friends/request', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const target = lower(normalizeUsername(String((req.body && req.body.username) || '')));
  const me = lower(account.username);
  if (!target) return res.status(400).json({ error: 'Type a username.' });
  if (target === me) return res.status(400).json({ error: "That's you — you're already on your own side." });
  const other = accounts.get(target);
  if (!other) return res.status(404).json({ error: `No one around here goes by "${target}" yet.` });
  if (areFriends(me, target)) return res.status(409).json({ error: 'You’re already friends.' });
  // reciprocal request pending → auto-accept
  const incoming = (friendRequests.get(me) || []).find((r) => r.from === target);
  if (incoming) {
    removeFriendRequest(target, me);
    setFriendship(me, target, true);
    saveFriends();
    pushFriendsTo(me); pushFriendsTo(target);
    pushUserLists();
    pushDmsTo(me); pushDmsTo(target);
    console.log(`friends (auto-accept): ${me} <-> ${target}`);
    return res.json({ status: 'accepted', friends: friendsPayloadFor(me) });
  }
  if (addFriendRequest(me, target)) {
    saveFriends();
    pushFriendsTo(target); pushFriendsTo(me);
    console.log(`friend request: ${me} -> ${target}`);
    return res.json({ status: 'requested', friends: friendsPayloadFor(me) });
  }
  return res.status(409).json({ error: 'Already requested — hang tight.' });
});

app.post('/api/friends/respond', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const from = lower(normalizeUsername(String((req.body && req.body.username) || '')));
  const accept = !!(req.body && req.body.accept);
  const me = lower(account.username);
  const pending = (friendRequests.get(me) || []).find((r) => r.from === from);
  if (!pending) return res.status(404).json({ error: 'No pending request from them.' });
  removeFriendRequest(from, me);
  if (accept) {
    setFriendship(me, from, true);
    console.log(`friend accepted: ${me} <-> ${from}`);
  } else {
    console.log(`friend declined: ${from} -> ${me}`);
  }
  saveFriends();
  pushFriendsTo(me); pushFriendsTo(from);
  if (accept) { pushUserLists(); pushDmsTo(me); pushDmsTo(from); }
  res.json({ status: accept ? 'accepted' : 'declined', friends: friendsPayloadFor(me) });
});

app.post('/api/friends/remove', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const other = lower(normalizeUsername(String((req.body && req.body.username) || '')));
  const me = lower(account.username);
  if (!areFriends(me, other)) return res.status(400).json({ error: "You're not friends with them." });
  setFriendship(me, other, false);
  saveFriends();
  pushFriendsTo(me); pushFriendsTo(other);
  pushUserLists();
  pushDmsTo(me); pushDmsTo(other);
  console.log(`friend removed: ${me} <-> ${other}`);
  res.json({ ok: true, friends: friendsPayloadFor(me) });
});

app.post('/api/friends/cancel', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const target = lower(normalizeUsername(String((req.body && req.body.username) || '')));
  const me = lower(account.username);
  const pending = (friendRequests.get(target) || []).find((r) => r.from === me);
  if (!pending) return res.status(404).json({ error: 'No outgoing request to them.' });
  removeFriendRequest(me, target);
  saveFriends();
  pushFriendsTo(me); pushFriendsTo(target);
  console.log(`friend request cancelled: ${me} -> ${target}`);
  res.json({ ok: true, friends: friendsPayloadFor(me) });
});

app.post('/api/servers/leave', (req, res) => {
  const account = tokenAccount(req, res);
  if (!account) return;
  const serverId = String((req.body && req.body.serverId) || '');
  const rec = servers.get(serverId);
  if (!rec) return res.status(404).json({ error: 'No such server.' });
  const me = lower(account.username);
  if (!rec.members.includes(me)) return res.status(400).json({ error: "You're not in that server." });
  if (rec.owner === me) {
    return res.status(400).json({ error: 'You own this server — leave is disabled for owners (server deletion is not here yet).' });
  }
  rec.members = rec.members.filter((m) => m !== me);
  saveServers();
  pushChannelsToServer(serverId);
  pushUserLists();
  pushVoiceLists();
  reinitUser(me);
  console.log(`server left: ${rec.name} (${rec.id}) by ${me}`);
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
      username: lower(account.username),
      name,
      color: account.color,
      voiceRoom: null,
      audio: true,
      video: false,
      screen: false,
    };
    users.set(socket.id, user);

    socket.emit('init', initFor(user));
    socket.emit('friends', friendsPayloadFor(user.username));
    pushUserLists();
    pushVoiceLists();
    refreshFriendsPresence();
  });

  /* ---------------- text chat ---------------- */

  socket.on('text:open', ({ channelId } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (typeof channelId === 'string' && channelId.startsWith('dm:')) {
      if (!dmAuthorized(channelId, user.username)) return;
      socket.emit('text:history', { channelId, messages: history.get(channelId) || [] });
      return;
    }
    const ch = channelById(channelId);
    if (!ch || ch.type !== 'text' || !memberOfServer(user.username, ch.serverId)) return;
    socket.emit('text:history', { channelId, messages: history.get(channelId) || [] });
  });

  socket.on('text:send', ({ channelId, text } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    const isDm = typeof channelId === 'string' && channelId.startsWith('dm:');
    let ch = null;
    if (isDm) {
      if (!dmAuthorized(channelId, user.username)) return;
    } else {
      ch = channelById(channelId);
      if (!ch || ch.type !== 'text' || !memberOfServer(user.username, ch.serverId)) return;
    }
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
    if (isDm) {
      emitToDmPair(dmPair(channelId), 'text:message', msg);
      emitDmSummaries(dmPair(channelId));
    } else {
      emitToServerMembers(ch.serverId, 'text:message', msg);
    }
  });

  /* emoji reactions — toggle on/off, broadcast the fresh counts */
  const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '🎉', '😮', '🔥']);

  socket.on('text:react', ({ channelId, messageId, emoji } = {}) => {
    const user = users.get(socket.id);
    if (!user || !ALLOWED_REACTIONS.has(emoji)) return;
    const isDm = typeof channelId === 'string' && channelId.startsWith('dm:');
    const ch = isDm ? null : channelById(channelId);
    if (isDm) {
      if (!dmAuthorized(channelId, user.username)) return;
    } else if (!ch || !memberOfServer(user.username, ch.serverId)) return;
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

    if (isDm) {
      saveDms(); // persist reaction counts too
      emitToDmPair(dmPair(channelId), 'text:reaction', { channelId, messageId: msg.id, reactions: msg.reactions });
    } else {
      emitToServerMembers(ch.serverId, 'text:reaction', { channelId, messageId: msg.id, reactions: msg.reactions });
    }
  });

  socket.on('typing', ({ channelId } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (typeof channelId === 'string' && channelId.startsWith('dm:')) {
      if (!dmAuthorized(channelId, user.username)) return;
      emitToDmPair(dmPair(channelId), 'typing', { channelId, userId: user.id, name: user.name }, socket.id);
      return;
    }
    const ch = channelById(channelId);
    if (!ch || !memberOfServer(user.username, ch.serverId)) return;
    emitToServerMembers(ch.serverId, 'typing', { channelId, userId: user.id, name: user.name }, socket.id);
  });

  socket.on('channel:create', ({ name, type, serverId } = {}) => {
    const user = users.get(socket.id);
    if (!user || !serverId || !memberOfServer(user.username, serverId)) return;
    const inServer = channelsArr.filter((c) => c.serverId === serverId);
    if (inServer.length >= MAX_CHANNELS_PER_SERVER) return;
    name = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\- ]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 24);
    if (!name) return;
    if (inServer.some((c) => c.name === name)) return;
    if (type !== 'voice') type = 'text';

    const id = `${type === 'voice' ? 'v' : 't'}-${Date.now().toString(36)}`;
    const record = { id, serverId, name, type, topic: type === 'voice' ? 'Voice channel' : 'Text channel' };
    channelsArr.push(record);
    channelIndex.set(id, record);
    if (type === 'text') history.set(id, []);
    saveServers();
    pushChannelsToServer(serverId);
  });

  /* ---------------- voice / video ---------------- */

  socket.on('voice:join', ({ channelId } = {}) => {
    const user = users.get(socket.id);
    const ch = channelById(channelId);
    if (!user || !ch || ch.type !== 'voice' || !memberOfServer(user.username, ch.serverId)) return;
    if (user.voiceRoom === channelId) return;

    user.voiceRoom = channelId;
    user.audio = true;
    user.video = false;
    user.screen = false;

    const peers = voiceParticipants().filter((p) => p.id !== socket.id && p.channel === channelId);
    socket.emit('voice:peers', { channel: channelId, peers });
    pushVoiceLists();
  });

  socket.on('voice:leave', () => {
    const user = users.get(socket.id);
    if (!user || !user.voiceRoom) return;
    const roomCh = channelById(user.voiceRoom);
    user.voiceRoom = null;
    user.video = false;
    user.screen = false;
    if (roomCh) emitToServerMembers(roomCh.serverId, 'voice:leave', { peerId: socket.id });
    pushVoiceLists();
  });

  socket.on('voice:state', (payload = {}) => {
    const user = users.get(socket.id);
    if (!user || !user.voiceRoom) return;
    if (typeof payload.audio === 'boolean') user.audio = payload.audio;
    if (typeof payload.video === 'boolean') user.video = payload.video;
    if (typeof payload.screen === 'boolean') user.screen = payload.screen;
    pushVoiceLists();
  });

  socket.on('voice:signal', ({ to, data } = {}) => {
    if (!to || !data || !users.has(to)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  /* ---------------- disconnect ---------------- */

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomCh = user.voiceRoom ? channelById(user.voiceRoom) : null;
    if (roomCh) emitToServerMembers(roomCh.serverId, 'voice:leave', { peerId: socket.id });
    users.delete(socket.id);
    if (user.voiceRoom) pushVoiceLists();
    pushUserLists();
    refreshFriendsPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Sold running at http://localhost:${PORT}`);
});
