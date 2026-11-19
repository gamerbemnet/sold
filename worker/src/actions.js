/* Client -> server actions, applied on top of loaded state.
 * Effects (anything that must reach clients) are appended to ctx.effects.
 * ctx.caller is the acting user's lower-cased username. */
import {
  LOWER, ALLOWED_REACTIONS, MAX_CHANNELS_PER_SERVER, newMessageId,
} from './const.js';
import { saveServers, saveThread, savePresence, pushHistory } from './state.js';
import {
  channelById, memberOfServer, dmAuthorized, dmPair, emit, emitToServerMembers,
  emitToDmPair, emitDmSummaries, pushChannelsToServer, pushVoiceLists,
  voiceParticipants, sharesSpace,
} from './domain.js';

/* Make sure a presence entry exists for this client and is freshly seen. */
export function ensurePresence(st, clientId, account) {
  const username = LOWER(account.username);
  const existing = st.presence[clientId];
  if (existing) {
    existing.lastSeen = st.now;
    existing.username = username;
    return existing;
  }
  const taken = new Set(Object.values(st.presence).map((u) => String(u.name || '').toLowerCase()));
  let name = account.username.slice(0, 24);
  if (taken.has(name.toLowerCase())) {
    let i = 2;
    while (taken.has(`${name} ${i}`.toLowerCase())) i++;
    name = `${name} ${i}`.slice(0, 24);
  }
  const entry = {
    id: clientId,
    username,
    name,
    color: account.color || '#5865f2',
    voiceRoom: null,
    audio: true,
    video: false,
    screen: false,
    lastSeen: st.now,
  };
  st.presence[clientId] = entry;
  st.presenceDirty = true;
  return entry;
}

/* ---------------- action switch ---------------- */

export async function applyAction(st, ctx, account, n, b) {
  b = b || {};
  const me = LOWER(account.username);
  // actions implicitly keep the caller's presence entry alive; anything that
  // mutates it (lastSeen refresh, voice moves) is persisted in finally
  const user = ensurePresence(st, ctx.clientId, account);

  try {
  switch (n) {
    case 'text:open': {
      const channelId = b.channelId;
      if (typeof channelId === 'string' && channelId.startsWith('dm:')) {
        if (!dmAuthorized(st, channelId, me)) return;
      } else {
        const ch = channelById(st, channelId);
        if (!ch || ch.type !== 'text' || !memberOfServer(st, me, ch.serverId)) return;
      }
      emit(ctx, me, 'text:history', { channelId, messages: st.history.get(channelId) || [] });
      return;
    }

    case 'text:send': {
      const channelId = b.channelId;
      const isDm = typeof channelId === 'string' && channelId.startsWith('dm:');
      let ch = null;
      if (isDm) {
        if (!dmAuthorized(st, channelId, me)) return;
      } else {
        ch = channelById(st, channelId);
        if (!ch || ch.type !== 'text' || !memberOfServer(st, me, ch.serverId)) return;
      }
      const text = String(b.text || '').trim().slice(0, 2000);
      if (!text) return;
      const msg = {
        id: newMessageId(),
        channelId,
        userId: ctx.clientId,
        name: user.name,
        color: user.color,
        text,
        reactions: {},
        ts: Date.now(),
      };
      pushHistory(st, channelId, msg);
      await saveThread(ctx.env, st, channelId);
      if (isDm) {
        emitToDmPair(st, ctx, dmPair(channelId), 'text:message', msg);
        emitDmSummaries(st, ctx, dmPair(channelId));
      } else {
        emitToServerMembers(st, ctx, ch.serverId, 'text:message', msg);
      }
      return;
    }

    case 'text:react': {
      const channelId = b.channelId;
      const emoji = b.emoji;
      if (!ALLOWED_REACTIONS.has(emoji)) return;
      const isDm = typeof channelId === 'string' && channelId.startsWith('dm:');
      const ch = isDm ? null : channelById(st, channelId);
      if (isDm) {
        if (!dmAuthorized(st, channelId, me)) return;
      } else if (!ch || !memberOfServer(st, me, ch.serverId)) return;
      const list = st.history.get(channelId);
      if (!list) return;
      const msg = list.find((m) => m.id === Number(b.messageId));
      if (!msg) return;
      if (!msg.reactions) msg.reactions = {};
      const voters = msg.reactions[emoji] || [];
      const i = voters.indexOf(user.id);
      if (i >= 0) voters.splice(i, 1); else voters.push(user.id);
      if (voters.length) msg.reactions[emoji] = voters; else delete msg.reactions[emoji];
      await saveThread(ctx.env, st, channelId);
      const payload = { channelId, messageId: msg.id, reactions: msg.reactions };
      if (isDm) emitToDmPair(st, ctx, dmPair(channelId), 'text:reaction', payload);
      else emitToServerMembers(st, ctx, ch.serverId, 'text:reaction', payload);
      return;
    }

    case 'typing': {
      const channelId = b.channelId;
      const payload = { channelId, userId: user.id, name: user.name };
      if (typeof channelId === 'string' && channelId.startsWith('dm:')) {
        if (!dmAuthorized(st, channelId, me)) return;
        emitToDmPair(st, ctx, dmPair(channelId), 'typing', payload);
        return;
      }
      const ch = channelById(st, channelId);
      if (!ch || !memberOfServer(st, me, ch.serverId)) return;
      emitToServerMembers(st, ctx, ch.serverId, 'typing', payload);
      return;
    }

    case 'channel:create': {
      const serverId = b.serverId;
      if (!serverId || !memberOfServer(st, me, serverId)) return;
      const inServer = st.channelsArr.filter((c) => c.serverId === serverId);
      if (inServer.length >= MAX_CHANNELS_PER_SERVER) return;
      const name = String(b.name || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9\- ]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 24);
      if (!name) return;
      if (inServer.some((c) => c.name === name)) return;
      const type = b.type === 'voice' ? 'voice' : 'text';
      const id = `${type === 'voice' ? 'v' : 't'}-${Date.now().toString(36)}`;
      const record = {
        id, serverId, name, type,
        topic: type === 'voice' ? 'Voice channel' : 'Text channel',
      };
      st.channelsArr.push(record);
      st.channelIndex.set(id, record);
      if (type === 'text') st.history.set(id, []);
      await saveServers(ctx.env, st);
      pushChannelsToServer(st, ctx, serverId);
      return;
    }

    case 'voice:join': {
      const u = ensurePresence(st, ctx.clientId, account);
      const channelId = b.channelId;
      const ch = channelById(st, channelId);
      if (!ch || ch.type !== 'voice' || !memberOfServer(st, me, ch.serverId)) return;
      if (u.voiceRoom === channelId) return;
      u.voiceRoom = channelId;
      u.audio = true;
      u.video = false;
      u.screen = false;
      u.lastSeen = st.now;
      await savePresence(ctx.env, st);
      const peers = voiceParticipants(st).filter((p) => p.id !== ctx.clientId && p.channel === channelId);
      emit(ctx, me, 'voice:peers', { channel: channelId, peers });
      pushVoiceLists(st, ctx);
      return;
    }

    case 'voice:leave': {
      if (!user || !user.voiceRoom) return;
      const roomCh = channelById(st, user.voiceRoom);
      user.voiceRoom = null;
      user.video = false;
      user.screen = false;
      user.lastSeen = st.now;
      await savePresence(ctx.env, st);
      if (roomCh) emitToServerMembers(st, ctx, roomCh.serverId, 'voice:leave', { peerId: ctx.clientId });
      pushVoiceLists(st, ctx);
      return;
    }

    case 'voice:state': {
      const u = ensurePresence(st, ctx.clientId, account);
      if (!u.voiceRoom) return;
      if (typeof b.audio === 'boolean') u.audio = b.audio;
      if (typeof b.video === 'boolean') u.video = b.video;
      if (typeof b.screen === 'boolean') u.screen = b.screen;
      u.lastSeen = st.now;
      await savePresence(ctx.env, st);
      pushVoiceLists(st, ctx);
      return;
    }

    case 'voice:signal': {
      const to = b.to;
      const data = b.data;
      if (!to || !data) return;
      const target = st.presence[to];
      if (!target) return;
      // only signal peers inside the same server as the caller (or friends)
      if (!sharesSpace(st, me, target.username)) return;
      emit(ctx, target.username, 'voice:signal', { from: ctx.clientId, to, data });
      return;
    }

    case 'heartbeat': {
      return; // ensurePresence at the top already refreshed lastSeen
    }

    default:
      return;
  }
  } finally {
    if (st.presenceDirty) {
      try { await savePresence(ctx.env, st); } catch (err) { console.warn('presence save failed:', err && err.message); }
    }
  }
}

