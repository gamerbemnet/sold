/* Domain logic for the Sold backend — pure functions over a loaded state
 * object (see state.js). Anything that should reach clients is appended to
 * ctx.effects as { to, event, body } and flushed to per-user R2 outboxes by
 * the caller (see outbox.js). */
import { LOWER } from './const.js';

/* ---------------- realtime effect collection ---------------- */

export function emit(ctx, to, event, body) {
  const target = LOWER(to);
  if (target) ctx.effects.push({ to: target, event, body });
}
export function emitToServerMembers(st, ctx, serverId, event, payload) {
  for (const u of Object.values(st.presence)) {
    if (memberOfServer(st, u.username, serverId)) emit(ctx, u.username, event, payload);
  }
}
export function emitToDmPair(st, ctx, pair, event, payload) {
  for (const u of Object.values(st.presence)) {
    if (pair[0] === u.username || pair[1] === u.username) emit(ctx, u.username, event, payload);
  }
}

/* ---------------- servers / channels ---------------- */

export const channelById = (st, id) => st.channelIndex.get(id);
export const serversFor = (st, username) =>
  [...st.servers.values()].filter((s) => s.members.includes(LOWER(username)));
export const memberOfServer = (st, username, serverId) => {
  const s = st.servers.get(serverId);
  return !!s && s.members.includes(LOWER(username));
};
export const sharedServer = (st, a, b) => {
  const asa = new Set(serversFor(st, a).map((s) => s.id));
  return serversFor(st, b).some((s) => asa.has(s.id));
};
export const channelsForUser = (st, username) => {
  const mine = new Set(serversFor(st, username).map((s) => s.id));
  return st.channelsArr.filter((c) => mine.has(c.serverId));
};
export const publicServer = (s) => ({
  id: s.id, name: s.name, color: s.color, owner: s.owner,
  invite: s.invite, members: [...s.members], createdAt: s.createdAt,
});

/* ---------------- presence / voice ---------------- */

export const onlineUsernames = (st) =>
  new Set(Object.values(st.presence).map((u) => LOWER(u.username)));
export const voiceParticipants = (st) =>
  Object.values(st.presence)
    .filter((u) => u.voiceRoom)
    .map((u) => ({
      id: u.id, name: u.name, color: u.color,
      channel: u.voiceRoom,
      serverId: (st.channelIndex.get(u.voiceRoom) || {}).serverId || null,
      audio: u.audio, video: u.video, screen: u.screen,
    }));
export const scopedVoiceFor = (st, username) =>
  voiceParticipants(st).filter((p) => p.serverId && memberOfServer(st, username, p.serverId));
export const scopedUsersFor = (st, username) =>
  Object.values(st.presence)
    .filter((o) => sharesSpace(st, o.username, username))
    .map((o) => ({
      id: o.id, name: o.name, color: o.color, voiceRoom: o.voiceRoom,
      servers: serversFor(st, o.username).map((s) => s.id),
    }));

export function pushUserLists(st, ctx) {
  for (const username of new Set(Object.values(st.presence).map((u) => LOWER(u.username)))) {
    emit(ctx, username, 'users', scopedUsersFor(st, username));
  }
}
export function pushVoiceLists(st, ctx) {
  for (const username of new Set(Object.values(st.presence).map((u) => LOWER(u.username)))) {
    emit(ctx, username, 'voice:update', scopedVoiceFor(st, username));
  }
}
export function refreshFriendsPresence(st, ctx) {
  for (const username of new Set(Object.values(st.presence).map((u) => LOWER(u.username)))) {
    emit(ctx, username, 'friends', friendsPayloadFor(st, username));
  }
}
export function pushChannelsFor(st, ctx, username) {
  emit(ctx, username, 'channels', channelsForUser(st, username));
}
export function pushChannelsToServer(st, ctx, serverId) {
  for (const u of Object.values(st.presence)) {
    if (memberOfServer(st, u.username, serverId)) pushChannelsFor(st, ctx, u.username);
  }
}

/* ---------------- friends ---------------- */

export const areFriends = (st, a, b) => (st.friendships.get(LOWER(a)) || new Set()).has(LOWER(b));
export const friendsListOf = (st, u) => [...(st.friendships.get(LOWER(u)) || new Set())];
export const sharesSpace = (st, a, b) => sharedServer(st, a, b) || areFriends(st, a, b);
export function publicFriend(st, username, onlineSet) {
  const acc = st.accounts.get(LOWER(username));
  return {
    username: acc ? acc.username : username,
    color: acc ? acc.color : '#5865f2',
    online: onlineSet.has(LOWER(username)),
  };
}
export function friendsPayloadFor(st, username) {
  const u = LOWER(username);
  const online = onlineUsernames(st);
  const friends = friendsListOf(st, u)
    .map((f) => publicFriend(st, f, online))
    .sort((x, y) => Number(y.online) - Number(x.online) || x.username.localeCompare(y.username));
  const incoming = (st.friendRequests.get(u) || []).map((r) => {
    const acc = st.accounts.get(r.from);
    return { username: acc ? acc.username : r.from, color: acc ? acc.color : '#5865f2', ts: r.ts };
  });
  const outgoing = [];
  for (const [to, list] of st.friendRequests) {
    for (const r of list) if (r.from === u) outgoing.push({ username: to, ts: r.ts });
  }
  return { friends, incoming, outgoing };
}
export function setFriendship(st, a, b, on) {
  a = LOWER(a); b = LOWER(b);
  const add = (x, y) => { const s = new Set(st.friendships.get(x) || []); s.add(y); st.friendships.set(x, s); };
  const del = (x, y) => { const s = new Set(st.friendships.get(x) || []); s.delete(y); if (s.size) st.friendships.set(x, s); else st.friendships.delete(x); };
  if (on) { add(a, b); add(b, a); } else { del(a, b); del(b, a); }
}
export function addFriendRequest(st, from, to) {
  const list = st.friendRequests.get(to) || [];
  if (list.some((r) => r.from === from)) return false;
  st.friendRequests.set(to, [...list, { from, ts: Date.now() }]);
  return true;
}
export function removeFriendRequest(st, from, to) {
  const list = st.friendRequests.get(to) || [];
  const next = list.filter((r) => r.from !== from);
  if (next.length) st.friendRequests.set(to, next); else st.friendRequests.delete(to);
}
export function pushFriendsTo(st, ctx, username) {
  emit(ctx, username, 'friends', friendsPayloadFor(st, username));
}

/* ---------------- DMs ---------------- */

export function dmPair(channelId) {
  if (typeof channelId !== 'string' || !channelId.startsWith('dm:')) return null;
  const [a, b] = channelId.slice(3).split('::');
  if (!a || !b || a === b) return null;
  return [a, b];
}
export const dmKey = (a, b) => `dm:${[LOWER(a), LOWER(b)].sort().join('::')}`;
export const dmAuthorized = (st, channelId, username) => {
  const pair = dmPair(channelId);
  return !!pair && (pair[0] === username || pair[1] === username) && areFriends(st, pair[0], pair[1]);
};
export function dmSummariesFor(st, username) {
  const u = LOWER(username);
  const online = onlineUsernames(st);
  const out = [];
  for (const [key, list] of st.history) {
    if (!key.startsWith('dm:')) continue;
    const pair = dmPair(key);
    if (!pair || (pair[0] !== u && pair[1] !== u)) continue;
    const other = pair[0] === u ? pair[1] : pair[0];
    if (!areFriends(st, u, other)) continue;
    const acc = st.accounts.get(other);
    const last = list[list.length - 1];
    out.push({
      key, with: other,
      name: acc ? acc.username : other,
      color: acc ? acc.color : '#5865f2',
      online: online.has(other),
      last: last ? { text: last.text, ts: last.ts, from: LOWER(last.name) === u ? 'me' : other } : null,
    });
  }
  return out.sort((x, y) => ((y.last && y.last.ts) || 0) - ((x.last && x.last.ts) || 0));
}
export function emitDmSummaries(st, ctx, pair) {
  emit(ctx, pair[0], 'dms', dmSummariesFor(st, pair[0]));
  emit(ctx, pair[1], 'dms', dmSummariesFor(st, pair[1]));
}
export const pushDmsTo = (st, ctx, username) => emit(ctx, username, 'dms', dmSummariesFor(st, username));


