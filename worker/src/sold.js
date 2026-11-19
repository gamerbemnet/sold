/* Sold backend — request handling for the stateless R2-backed Worker.
 * See state.js for the storage layout. Realtime delivery happens via
 * per-user outboxes (outbox.js) consumed by SSE streams (/api/events);
 * client -> server traffic goes through POST /api/action. */
import {
  LOWER, SESSION_TTL_MS, CLIENT_ID_RE, USERNAME_RE, COLORS,
  TURN_UPSTREAM, TURN_UPSTREAM_HEADERS, TURN_REFRESH_MS, DEFAULT_CHANNEL_SEED,
  SERVER_COLORS, MAX_SERVERS_PER_USER, randHex, randInt, timingSafeEqualStr,
  normalizeUsername, CORS_HEADERS, jsonRes,
  MAX_MEDIA_BYTES, sniffImageType, avatarKey, bannerKey, serverBannerKey,
} from './const.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  loadState, saveAccounts, saveServers, saveFriends, saveDms, saveHistory,
  savePresence, r2Get, r2Put,
} from './state.js';
import {
  publicServer, serversFor, channelsForUser, memberOfServer, areFriends,
  friendsPayloadFor, dmAuthorized, dmSummariesFor, scopedUsersFor, scopedVoiceFor,
  setFriendship, addFriendRequest, removeFriendRequest, pushFriendsTo, pushDmsTo,
  pushChannelsToServer, pushChannelsFor, pushUserLists, pushVoiceLists,
  refreshFriendsPresence, emitToServerMembers, sharesSpace, pushDmsForAllPresent,
} from './domain.js';
import { flushEffects, outboxCursor, outboxRead } from './outbox.js';
import { applyAction, ensurePresence } from './actions.js';

const authAttempts = new Map(); // ip -> { count, resetAt } (best effort, per isolate)

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
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

async function createSession(env, st, username) {
  const token = randHex(32);
  const now = st.now;
  for (const [t, s] of st.sessions) if (s.expiresAt < now) st.sessions.delete(t);
  st.sessions.set(token, { username: LOWER(username), expiresAt: now + SESSION_TTL_MS });
  await saveAccounts(env, st);
  return token;
}

async function sessionAccount(env, st, token) {
  if (typeof token !== 'string' || token.length < 32) return null;
  const session = st.sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    st.sessions.delete(token);
    await saveAccounts(env, st);
    return null;
  }
  return st.accounts.get(LOWER(session.username)) || null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/* ---------- media (avatars / banners) -------------------------------- */

const mediaHeaders = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  ...CORS_HEADERS,
};

async function serveMedia(env, key) {
  try {
    const obj = await env.SOLD_DATA.get(key);
    if (!obj) return jsonRes({ error: 'not found' }, 404);
    const bytes = await obj.arrayBuffer();
    const type = sniffImageType(new Uint8Array(bytes)) || 'application/octet-stream';
    return new Response(bytes, { headers: { 'Content-Type': type, ...mediaHeaders } });
  } catch (err) {
    console.warn('media read failed:', err && err.message);
    return jsonRes({ error: 'not found' }, 404);
  }
}

/* raw-binary image upload: size + magic-byte validation (animated GIF/WebP
 * pass through untouched, which is what makes them animate in <img>) */
async function readMediaUpload(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_MEDIA_BYTES) {
    return { error: jsonRes({ error: 'Image too big — 4 MB max.' }, 413) };
  }
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (_) {
    return { error: jsonRes({ error: 'Could not read the upload.' }, 400) };
  }
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    return { error: jsonRes({ error: 'Image too big — 4 MB max.' }, 413) };
  }
  const type = sniffImageType(new Uint8Array(buf));
  if (!type) {
    return { error: jsonRes({ error: 'Only JPEG, PNG, GIF or WebP images.' }, 415) };
  }
  return { buf, type };
}

/* after any media change: tell every present client so avatars/banners
 * refresh live everywhere (members, friends, DMs) */
async function pushMediaRefresh(env, st, me) {
  const actor = { env, effects: [], clientId: null, caller: LOWER(me) };
  pushUserLists(st, actor);
  refreshFriendsPresence(st, actor);
  pushDmsForAllPresent(st, actor);
  pushVoiceLists(st, actor);
  try { await flushEffects(env, actor.effects); } catch (err) { console.warn('media push failed:', err && err.message); }
}

/* TURN credentials, cached in R2 so isolates share one upstream fetch. */
async function getTurnCredentials(env) {
  const now = Date.now();
  const cached = await r2Get(env, 'turn');
  if (cached && cached.data && now - cached.at < TURN_REFRESH_MS) return cached.data;
  let data = cached ? cached.data : null;
  let lastError = null;
  try {
    const res = await fetch(TURN_UPSTREAM, {
      headers: TURN_UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const parsed = await res.json();
    if (!parsed || !parsed.username || !parsed.credential || !Array.isArray(parsed.urls)) {
      throw new Error('unexpected payload');
    }
    data = parsed;
    await r2Put(env, 'turn', { at: now, data, lastError: null });
  } catch (err) {
    lastError = err.message;
    if (!data) return { error: lastError };
  }
  return data;
}

/* ================= HTTP routes ================= */

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method || 'GET';

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    /* ---------- media: public GET (<img> can't carry auth) ------------- */
    const mediaGet = /^\/api\/(avatar|banner|server-banner)\/([a-z0-9_.-]{1,48})$/i.exec(path);
    if (mediaGet && method === 'GET') {
      const kind = mediaGet[1].toLowerCase();
      const id = mediaGet[2];
      const key = kind === 'avatar' ? avatarKey(id) : kind === 'banner' ? bannerKey(id) : serverBannerKey(id);
      return await serveMedia(env, key);
    }

    /* ---------- media: uploads (raw binary — before JSON parsing) ------ */
    if ((path === '/api/account/avatar' || path === '/api/account/banner') &&
        (method === 'POST' || method === 'DELETE')) {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String(url.searchParams.get('token') || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const isAvatar = path === '/api/account/avatar';
      const key = isAvatar ? avatarKey(account.username) : bannerKey(account.username);
      const stored = st.accounts.get(LOWER(account.username));
      if (method === 'DELETE') {
        try { await env.SOLD_DATA.delete(key); } catch (_) { /* already gone */ }
        if (stored) {
          if (isAvatar) stored.avatarAt = 0; else stored.bannerAt = 0;
          st.accounts.set(LOWER(account.username), stored);
          await saveAccounts(env, st);
        }
        await pushMediaRefresh(env, st, account.username);
        return jsonRes(isAvatar ? { ok: true, avatarAt: 0 } : { ok: true, bannerAt: 0 });
      }
      const up = await readMediaUpload(request);
      if (up.error) return up.error;
      await env.SOLD_DATA.put(key, up.buf, { httpMetadata: { contentType: up.type } });
      const stamp = Date.now();
      if (stored) {
        if (isAvatar) stored.avatarAt = stamp; else stored.bannerAt = stamp;
        st.accounts.set(LOWER(account.username), stored);
        await saveAccounts(env, st);
      }
      await pushMediaRefresh(env, st, account.username);
      return jsonRes(isAvatar ? { ok: true, avatarAt: stamp } : { ok: true, bannerAt: stamp });
    }

    if (path === '/api/servers/banner' && (method === 'POST' || method === 'DELETE')) {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String(url.searchParams.get('token') || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const me = LOWER(account.username);
      const serverId = String(url.searchParams.get('serverId') || '');
      const srv = st.servers.get(serverId);
      if (!srv) return jsonRes({ error: 'Server not found.' }, 404);
      if (srv.owner !== me) return jsonRes({ error: 'Only the server owner can change its banner.' }, 403);
      const key = serverBannerKey(serverId);
      const finish = async (bannerAt) => {
        srv.bannerAt = bannerAt;
        st.servers.set(serverId, srv);
        await saveServers(env, st);
        const actor = { env, effects: [], clientId: null, caller: me };
        emitToServerMembers(st, actor, serverId, 'server:banner', { serverId, bannerAt });
        try { await flushEffects(env, actor.effects); } catch (err) { console.warn('banner push failed:', err && err.message); }
        return jsonRes({ ok: true, bannerAt });
      };
      if (method === 'DELETE') {
        try { await env.SOLD_DATA.delete(key); } catch (_) { /* already gone */ }
        return await finish(0);
      }
      const up = await readMediaUpload(request);
      if (up.error) return up.error;
      await env.SOLD_DATA.put(key, up.buf, { httpMetadata: { contentType: up.type } });
      return await finish(Date.now());
    }

    /* ---------- profile card -------------------------------------------- */
    if (path === '/api/profile' && method === 'GET') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String(url.searchParams.get('token') || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const me = LOWER(account.username);
      const target = LOWER(normalizeUsername(String(url.searchParams.get('username') || '')));
      const acc = st.accounts.get(target);
      if (!acc) return jsonRes({ error: `No one around here goes by "${target}" yet.` }, 404);
      const isSelf = target === me;
      const friend = areFriends(st, me, target);
      // only self / friends / people sharing a server may see a profile
      if (!isSelf && !friend && !sharesSpace(st, me, target)) {
        return jsonRes({ error: 'not allowed' }, 403);
      }
      const presenceHits = Object.values(st.presence).filter((p) => LOWER(p.username) === target);
      const incoming = (st.friendRequests.get(me) || []).some((r) => r.from === target);
      const outgoing = (st.friendRequests.get(target) || []).some((r) => r.from === me);
      return jsonRes({
        username: acc.username,
        color: acc.color,
        createdAt: acc.createdAt,
        avatarAt: acc.avatarAt || 0,
        bannerAt: acc.bannerAt || 0,
        online: presenceHits.length > 0,
        inCall: presenceHits.some((p) => p.voiceRoom),
        relation: isSelf ? 'self' : friend ? 'friend' : incoming ? 'pending-in' : outgoing ? 'pending-out' : 'none',
      });
    }

    if (path === '/api/health' && method === 'GET') {
      return jsonRes({ ok: true, service: 'sold-backend' });
    }

    if (path === '/api/turn' && method === 'GET') {
      const data = await getTurnCredentials(env);
      if (!data || data.error) {
        return jsonRes({ error: 'turn-unavailable', detail: data && data.error }, 503, { 'Cache-Control': 'no-store' });
      }
      return jsonRes(
        { urls: data.urls, username: data.username, credential: data.credential, expiresAt: Date.now() + TURN_REFRESH_MS },
        200,
        { 'Cache-Control': 'no-store' }
      );
    }

    const body = method === 'POST' ? await readJson(request) : null;
    const ip = clientIp(request);

    /* ---------- auth ---------- */
    if (path === '/api/signup' && method === 'POST') {
      if (authRateLimited(ip)) return jsonRes({ error: 'Too many attempts — try again in a few minutes.' }, 429);
      const username = normalizeUsername(body && body.username);
      const password = String((body && body.password) || '');
      if (!USERNAME_RE.test(username)) {
        return jsonRes({ error: 'Usernames are 3–24 characters: letters, numbers, and _ . -' }, 400);
      }
      if (password.length < 6 || password.length > 100) {
        return jsonRes({ error: 'Passwords need at least 6 characters.' }, 400);
      }
      const st = await loadState(env);
      const key = username.toLowerCase();
      if (st.accounts.has(key)) {
        return jsonRes({ error: "That name's already taken — try another?" }, 409);
      }
      const salt = randHex(16);
      const account = {
        username, salt,
        hash: await hashPassword(password, salt),
        color: COLORS[randInt(COLORS.length)],
        createdAt: Date.now(),
      };
      st.accounts.set(key, account);
      const token = await createSession(env, st, username);
      console.log(`account created: ${username}`);
      return jsonRes({ token, user: publicAccount(account) });
    }

    if (path === '/api/login' && method === 'POST') {
      if (authRateLimited(ip)) return jsonRes({ error: 'Too many attempts — try again in a few minutes.' }, 429);
      const username = normalizeUsername(body && body.username);
      const password = String((body && body.password) || '');
      const st = await loadState(env);
      const account = st.accounts.get(username.toLowerCase());
      if (!account || !(await verifyPassword(password, account))) {
        return jsonRes({ error: "Hmm, that username or password doesn't look right." }, 401);
      }
      const token = await createSession(env, st, account.username);
      return jsonRes({ token, user: publicAccount(account) });
    }

    if (path === '/api/logout' && method === 'POST') {
      const token = String((body && body.token) || '');
      const st = await loadState(env);
      if (st.sessions.has(token)) {
        st.sessions.delete(token);
        await saveAccounts(env, st);
      }
      return jsonRes({ ok: true });
    }

    if (path === '/api/account/password' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const current = String((body && body.currentPassword) || '');
      const next = String((body && body.newPassword) || '');
      if (!(await verifyPassword(current, account))) {
        return jsonRes({ error: 'Your current password is wrong.' }, 400);
      }
      if (next.length < 6 || next.length > 100) {
        return jsonRes({ error: 'Passwords need at least 6 characters.' }, 400);
      }
      const salt = randHex(16);
      account.salt = salt;
      account.hash = await hashPassword(next, salt);
      const key = LOWER(account.username);
      st.accounts.set(key, account);
      const now = st.now;
      const currentToken = String(body.token);
      for (const [t, s] of st.sessions) {
        if (t !== currentToken && LOWER(s.username) === key) st.sessions.delete(t);
      }
      await saveAccounts(env, st);
      return jsonRes({ ok: true });
    }

    /* ---------- admin: export / import (bearer secret) ---------- */
    if (path === '/api/admin/export' || path === '/api/admin/import') {
      const secret = env.ADMIN_SECRET;
      const given = (body && body.secret) || url.searchParams.get('secret') || '';
      if (!secret || !timingSafeEqualStr(String(given), String(secret))) {
        return jsonRes({ error: 'forbidden' }, 403);
      }
      if (path === '/api/admin/export' && method === 'POST') {
        return jsonRes({
          accounts: (await r2Get(env, 'accounts')) || { accounts: {}, sessions: {} },
          servers: (await r2Get(env, 'servers')) || { servers: {}, channels: {} },
          friends: (await r2Get(env, 'friends')) || { friendships: {}, requests: {} },
          dms: (await r2Get(env, 'dms')) || { threads: {} },
          history: (await r2Get(env, 'history')) || { threads: {} },
        });
      }
      if (path === '/api/admin/import' && method === 'POST') {
        const files = (body && body.files) || {};
        const put = async (name, validate) => {
          const value = files[name];
          if (value === undefined) return;
          if (!validate(value)) throw new Error(`bad ${name} payload`);
          await r2Put(env, name, value);
        };
        await put('accounts', (v) => v && typeof v.accounts === 'object' && typeof v.sessions === 'object');
        await put('servers', (v) => v && typeof v.servers === 'object' && typeof v.channels === 'object');
        await put('friends', (v) => v && typeof v.friendships === 'object' && typeof v.requests === 'object');
        await put('dms', (v) => v && typeof v.threads === 'object');
        await put('history', (v) => v && typeof v.threads === 'object');
        return jsonRes({ ok: true });
      }
      return jsonRes({ error: 'method not allowed' }, 405);
    }

    /* ---------- snapshot for a freshly (re)connecting client ---------- */
    if (path === '/api/bootstrap' && method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const clientId = url.searchParams.get('clientId') || '';
      const st = await loadState(env);
      const account = await sessionAccount(env, st, token);
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const me = LOWER(account.username);
      const presence = CLIENT_ID_RE.test(clientId) ? st.presence[clientId] : null;
      const outboxNext = await outboxCursor(env, me);
      return jsonRes({
        me: {
          id: CLIENT_ID_RE.test(clientId) ? clientId : 'me',
          name: (presence && presence.name) || account.username,
          color: (presence && presence.color) || account.color,
          username: me,
          avatarAt: account.avatarAt || 0,
          bannerAt: account.bannerAt || 0,
        },
        servers: serversFor(st, me).map(publicServer),
        channels: channelsForUser(st, me),
        users: scopedUsersFor(st, me),
        voice: scopedVoiceFor(st, me),
        dms: dmSummariesFor(st, me),
        friends: friendsPayloadFor(st, me),
        outboxNext,
      }, 200, { 'Cache-Control': 'no-store' });
    }

    /* ---------- channel history on demand ---------- */
    if (path === '/api/history' && method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const channelId = String(url.searchParams.get('channelId') || '');
      const st = await loadState(env);
      const account = await sessionAccount(env, st, token);
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const me = LOWER(account.username);
      if (channelId.startsWith('dm:')) {
        if (!dmAuthorized(st, channelId, me)) return jsonRes({ error: 'not allowed' }, 403);
      } else {
        const ch = st.channelIndex.get(channelId);
        if (!ch || ch.type !== 'text' || !memberOfServer(st, me, ch.serverId)) {
          return jsonRes({ error: 'not allowed' }, 403);
        }
      }
      return jsonRes({ channelId, messages: st.history.get(channelId) || [] });
    }

    /* ---------- client -> server actions ---------- */
    if (path === '/api/action' && method === 'POST') {
      const token = String((body && body.token) || '');
      const clientId = String((body && body.clientId) || '');
      if (!CLIENT_ID_RE.test(clientId)) return jsonRes({ error: 'bad client id' }, 400);
      const st = await loadState(env);
      const account = await sessionAccount(env, st, token);
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId, caller: LOWER(account.username) };
      await applyAction(st, actor, account, body && body.n, body && body.b);
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      return jsonRes({ ok: true });
    }

    /* ---------- servers ---------- */
    if (path === '/api/servers/create' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      if (name.length < 2) return jsonRes({ error: 'Give your server a name (2+ characters).' }, 400);
      const me = LOWER(account.username);
      if (serversFor(st, me).length >= MAX_SERVERS_PER_USER) {
        return jsonRes({ error: `You can be in at most ${MAX_SERVERS_PER_USER} servers.` }, 400);
      }
      const id = 'srv-' + randHex(6);
      const rec = {
        id, name, owner: me,
        color: SERVER_COLORS[randInt(SERVER_COLORS.length)],
        invite: randHex(4), members: [me], createdAt: Date.now(),
      };
      st.servers.set(id, rec);
      for (const seed of DEFAULT_CHANNEL_SEED) {
        const chan = {
          id: `${seed.type === 'voice' ? 'v' : 't'}-${Date.now().toString(36)}-${randInt(0xffff)}`,
          serverId: id, ...seed,
        };
        st.channelsArr.push(chan);
        st.channelIndex.set(chan.id, chan);
        if (chan.type === 'text') st.history.set(chan.id, []);
      }
      await saveServers(env, st);
      console.log(`server created: ${name} (${id}) by ${me}`);
      return jsonRes({ server: publicServer(rec) });
    }

    if (path === '/api/servers/join' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const code = LOWER(String((body && body.invite) || '').trim());
      if (!code) return jsonRes({ error: 'Enter an invite code.' }, 400);
      const target = [...st.servers.values()].find((s) => LOWER(s.invite) === code);
      if (!target) {
        return jsonRes({ error: "That invite doesn't match any server — double-check the code?" }, 404);
      }
      const me = LOWER(account.username);
      if (target.members.length >= 100) return jsonRes({ error: 'That server is full.' }, 400);
      if (!target.members.includes(me)) {
        target.members.push(me);
        await saveServers(env, st);
        console.log(`server joined: ${target.name} (${target.id}) by ${me}`);
      }
      pushChannelsToServer(st, actor, target.id);
      pushUserLists(st, actor);
      pushVoiceLists(st, actor);
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      return jsonRes({ server: publicServer(target) });
    }

    if (path === '/api/servers/leave' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const serverId = String((body && body.serverId) || '');
      const rec = st.servers.get(serverId);
      if (!rec) return jsonRes({ error: 'No such server.' }, 404);
      const me = LOWER(account.username);
      if (!rec.members.includes(me)) return jsonRes({ error: "You're not in that server." }, 400);
      if (rec.owner === me) {
        return jsonRes({ error: 'You own this server — leave is disabled for owners (server deletion is not here yet).' }, 400);
      }
      rec.members = rec.members.filter((m) => m !== me);
      await saveServers(env, st);
      pushChannelsToServer(st, actor, serverId);
      pushUserLists(st, actor);
      pushVoiceLists(st, actor);
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      console.log(`server left: ${rec.name} (${rec.id}) by ${me}`);
      return jsonRes({ ok: true });
    }

    /* ---------- friends ---------- */
    if (path === '/api/friends/request' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const target = LOWER(normalizeUsername(String((body && body.username) || '')));
      const me = LOWER(account.username);
      if (!target) return jsonRes({ error: 'Type a username.' }, 400);
      if (target === me) return jsonRes({ error: "That's you — you're already on your own side." }, 400);
      const other = st.accounts.get(target);
      if (!other) return jsonRes({ error: `No one around here goes by "${target}" yet.` }, 404);
      if (areFriends(st, me, target)) return jsonRes({ error: 'You’re already friends.' }, 409);
      const incoming = (st.friendRequests.get(me) || []).find((r) => r.from === target);
      if (incoming) {
        removeFriendRequest(st, target, me);
        setFriendship(st, me, target, true);
        await saveFriends(env, st);
        pushFriendsTo(st, actor, me); pushFriendsTo(st, actor, target);
        pushUserLists(st, actor);
        pushDmsTo(st, actor, me); pushDmsTo(st, actor, target);
        try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
        console.log(`friends (auto-accept): ${me} <-> ${target}`);
        return jsonRes({ status: 'accepted', friends: friendsPayloadFor(st, me) });
      }
      if (addFriendRequest(st, me, target)) {
        await saveFriends(env, st);
        pushFriendsTo(st, actor, target); pushFriendsTo(st, actor, me);
        try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
        console.log(`friend request: ${me} -> ${target}`);
        return jsonRes({ status: 'requested', friends: friendsPayloadFor(st, me) });
      }
      return jsonRes({ error: 'Already requested — hang tight.' }, 409);
    }

    if (path === '/api/friends/respond' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const from = LOWER(normalizeUsername(String((body && body.username) || '')));
      const accept = !!(body && body.accept);
      const me = LOWER(account.username);
      const pending = (st.friendRequests.get(me) || []).find((r) => r.from === from);
      if (!pending) return jsonRes({ error: 'No pending request from them.' }, 404);
      removeFriendRequest(st, from, me);
      if (accept) {
        setFriendship(st, me, from, true);
        console.log(`friend accepted: ${me} <-> ${from}`);
      } else {
        console.log(`friend declined: ${from} -> ${me}`);
      }
      await saveFriends(env, st);
      pushFriendsTo(st, actor, me); pushFriendsTo(st, actor, from);
      if (accept) { pushUserLists(st, actor); pushDmsTo(st, actor, me); pushDmsTo(st, actor, from); }
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      return jsonRes({ status: accept ? 'accepted' : 'declined', friends: friendsPayloadFor(st, me) });
    }

    if (path === '/api/friends/remove' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const other = LOWER(normalizeUsername(String((body && body.username) || '')));
      const me = LOWER(account.username);
      if (!areFriends(st, me, other)) return jsonRes({ error: "You're not friends with them." }, 400);
      setFriendship(st, me, other, false);
      await saveFriends(env, st);
      pushFriendsTo(st, actor, me); pushFriendsTo(st, actor, other);
      pushUserLists(st, actor);
      pushDmsTo(st, actor, me); pushDmsTo(st, actor, other);
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      console.log(`friend removed: ${me} <-> ${other}`);
      return jsonRes({ ok: true, friends: friendsPayloadFor(st, me) });
    }

    if (path === '/api/friends/cancel' && method === 'POST') {
      const st = await loadState(env);
      const account = await sessionAccount(env, st, String((body && body.token) || ''));
      if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
      const actor = { env, effects: [], clientId: null, caller: LOWER(account.username) };
      const target = LOWER(normalizeUsername(String((body && body.username) || '')));
      const me = LOWER(account.username);
      const pending = (st.friendRequests.get(target) || []).find((r) => r.from === me);
      if (!pending) return jsonRes({ error: 'No outgoing request to them.' }, 404);
      removeFriendRequest(st, me, target);
      await saveFriends(env, st);
      pushFriendsTo(st, actor, me); pushFriendsTo(st, actor, target);
      try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }
      console.log(`friend request cancelled: ${me} -> ${target}`);
      return jsonRes({ ok: true, friends: friendsPayloadFor(st, me) });
    }

    return jsonRes({ error: 'not found' }, 404);
  } catch (err) {
    console.warn('http error:', err && err.message);
    return jsonRes({ error: 'internal error' }, 500);
  }
}

/* ================= SSE realtime stream ================= */

const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
  ...CORS_HEADERS,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Best-effort presence cleanup when a client's stream ends. Also used as a
 * safety sweep by other code paths. */
export async function removeClientPresence(env, clientId) {
  try {
    if (!CLIENT_ID_RE.test(clientId)) return;
    const st = await loadState(env);
    const entry = st.presence[clientId];
    if (!entry) return;
    const actor = { env, effects: [], clientId, caller: entry.username };
    const roomCh = entry.voiceRoom ? st.channelIndex.get(entry.voiceRoom) : null;
    delete st.presence[clientId];
    await savePresence(env, st);
    if (roomCh) emitToServerMembers(st, actor, roomCh.serverId, 'voice:leave', { peerId: clientId });
    pushUserLists(st, actor);
    pushVoiceLists(st, actor);
    refreshFriendsPresence(st, actor);
    await flushEffects(env, actor.effects);
  } catch (err) {
    console.warn('presence cleanup failed:', err && err.message);
  }
}

const ITER_MS = 800;        // outbox poll interval
const MAX_ITERS = 7000;     // ~93 minutes per stream; client reconnects seamlessly

export async function handleEvents(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const clientId = url.searchParams.get('clientId') || '';
  if (!CLIENT_ID_RE.test(clientId)) {
    return jsonRes({ error: 'bad client id' }, 400);
  }

  const st = await loadState(env);
  const account = await sessionAccount(env, st, token);
  if (!account) return jsonRes({ error: 'Please log in again.' }, 401);
  const me = LOWER(account.username);

  // (re)register presence for this client
  ensurePresence(st, clientId, account);
  await savePresence(env, st);
  const actor = { env, effects: [], clientId, caller: me };
  pushUserLists(st, actor);
  pushVoiceLists(st, actor);
  refreshFriendsPresence(st, actor);
  try { await flushEffects(env, actor.effects); } catch (err) { console.warn('flush failed:', err && err.message); }

  // resume position: explicit since param (reconnect) or current cursor (fresh)
  const sinceParam = url.searchParams.get('since');
  let cursor;
  if (sinceParam === null || sinceParam === '' || Number(sinceParam) < 0) {
    cursor = await outboxCursor(env, me);
  } else {
    cursor = Math.max(1, Math.floor(Number(sinceParam)) || 1);
  }

  const encoder = new TextEncoder();
  let aborted = false;
  const onAbort = () => { aborted = true; };
  try { request.signal.addEventListener('abort', onAbort); } catch (_) {}

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => {
        try { controller.enqueue(encoder.encode(chunk)); return true; }
        catch (_) { return false; }
      };
      send(': connected\n\n');
      send(`data: ${JSON.stringify({ n: 'hello', b: { id: clientId } })}\n\n`);
      let hb = 0;
      try {
        for (let i = 0; i < MAX_ITERS && !aborted; i++) {
          const res = await outboxRead(env, me, cursor);
          cursor = res.cursor;
          for (const item of res.items) {
            const ok = send(`id: ${item.seq}\ndata: ${JSON.stringify({ n: item.event, b: item.body })}\n\n`);
            if (!ok) { aborted = true; break; }
          }
          hb++;
          if (hb % 20 === 0) send(': hb\n\n');
          if (!aborted && res.items.length === 0) await sleep(ITER_MS);
        }
      } catch (err) {
        console.warn('sse loop error:', err && err.message);
      } finally {
        try { controller.close(); } catch (_) {}
        await removeClientPresence(env, clientId);
      }
    },
    cancel() { aborted = true; },
  });

  return new Response(stream, { headers: sseHeaders });
}
