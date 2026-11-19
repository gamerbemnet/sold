/* R2-backed state store for the Sold backend.
 *
 * Durable state lives in the bucket bound as SOLD_DATA (bucket
 * "project-sold-blob"). Keys:
 *   accounts  { accounts: {...}, sessions: {...} }
 *   servers   { servers: {...}, channels: {...} }
 *   friends   { friendships: { lowerName: [names] }, requests: { lowerName: [{ from, ts }] } }
 *   dms       { threads: { 'dm:a::b': [msg] } }       (cap 200 each)
 *   history   { threads: { channelId: [msg] } }        (server text channels, cap 200 each)
 *   presence  { [clientId]: { id, username, name, color, voiceRoom, audio, video, screen, lastSeen } }
 *   turn      { at, data }                             (cached upstream TURN credentials)
 *   outbox/<username> { next, items: [{ seq, event, body }] }  (realtime queue, cap 200)
 */
import { LOWER, MAX_HISTORY, PRESENCE_TTL_MS } from './const.js';

export async function r2Get(env, key, fallback = null) {
  try {
    const obj = await env.SOLD_DATA.get(key);
    if (!obj) return fallback;
    return JSON.parse(await obj.text());
  } catch {
    return fallback;
  }
}

export async function r2Put(env, key, value) {
  await env.SOLD_DATA.put(key, JSON.stringify(value));
}

export async function loadState(env) {
  const [accountsBlob, serversBlob, friendsBlob, dmsBlob, historyBlob, presence] = await Promise.all([
    r2Get(env, 'accounts'),
    r2Get(env, 'servers'),
    r2Get(env, 'friends'),
    r2Get(env, 'dms'),
    r2Get(env, 'history'),
    r2Get(env, 'presence', {}),
  ]);

  const st = {
    env,
    now: Date.now(),
    accounts: new Map(),
    sessions: new Map(),
    servers: new Map(),
    channelsArr: [],
    channelIndex: new Map(),
    friendships: new Map(),
    friendRequests: new Map(),
    history: new Map(),
    presence: presence && typeof presence === 'object' ? presence : {},
    presenceDirty: false,
  };

  if (accountsBlob) {
    st.accounts = new Map(Object.entries(accountsBlob.accounts || {}));
    st.sessions = new Map(Object.entries(accountsBlob.sessions || {}));
  }
  if (serversBlob) {
    st.servers = new Map(Object.entries(serversBlob.servers || {}));
    st.channelsArr = Object.values(serversBlob.channels || {});
    st.channelIndex = new Map(st.channelsArr.map((c) => [c.id, c]));
  }
  if (friendsBlob) {
    st.friendships = new Map(
      Object.entries(friendsBlob.friendships || {}).map(([k, v]) => [k, new Set(v)])
    );
    st.friendRequests = new Map(Object.entries(friendsBlob.requests || {}));
  }
  for (const blob of [historyBlob, dmsBlob]) {
    if (!blob || !blob.threads) continue;
    for (const [k, list] of Object.entries(blob.threads)) {
      if (Array.isArray(list)) st.history.set(k, list);
    }
  }
  for (const c of st.channelsArr) {
    if (c.type === 'text' && !st.history.has(c.id)) st.history.set(c.id, []);
  }
  for (const id of Object.keys(st.presence)) {
    const u = st.presence[id];
    if (!u || typeof u.lastSeen !== 'number' || st.now - u.lastSeen > PRESENCE_TTL_MS) {
      delete st.presence[id];
      st.presenceDirty = true;
    }
  }
  return st;
}

export const accountsBlobOf = (st) => ({
  accounts: Object.fromEntries(st.accounts),
  sessions: Object.fromEntries(st.sessions),
});
export const serversBlobOf = (st) => ({
  servers: Object.fromEntries(st.servers),
  channels: Object.fromEntries(st.channelIndex),
});
export const friendsBlobOf = (st) => ({
  friendships: Object.fromEntries([...st.friendships].map(([k, v]) => [k, [...v]])),
  requests: Object.fromEntries(st.friendRequests),
});
export const dmThreadsOf = (st) =>
  Object.fromEntries([...st.history].filter(([k]) => k.startsWith('dm:')));
export const historyThreadsOf = (st) =>
  Object.fromEntries([...st.history].filter(([k]) => !k.startsWith('dm:')));

export const saveAccounts = (env, st) => r2Put(env, 'accounts', accountsBlobOf(st));
export const saveServers = (env, st) => r2Put(env, 'servers', serversBlobOf(st));
export const saveFriends = (env, st) => r2Put(env, 'friends', friendsBlobOf(st));
export const saveDms = (env, st) => r2Put(env, 'dms', { threads: dmThreadsOf(st) });
export const saveHistory = (env, st) => r2Put(env, 'history', { threads: historyThreadsOf(st) });
export const savePresence = (env, st) => r2Put(env, 'presence', st.presence);
export const saveThread = (env, st, channelId) =>
  String(channelId).startsWith('dm:') ? saveDms(env, st) : saveHistory(env, st);

export function pushHistory(st, channelId, msg) {
  let list = st.history.get(channelId);
  if (!list && typeof channelId === 'string' && channelId.startsWith('dm:')) {
    list = [];
    st.history.set(channelId, list);
  }
  if (!list) return null;
  list.push(msg);
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  return list;
}
