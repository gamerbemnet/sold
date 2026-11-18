/* Functional test for the Sold server using raw Engine.IO/Socket.IO
 * protocol over Node's built-in WebSocket.
 *
 * The test spawns its OWN server instance in a throwaway data directory,
 * so it never touches your real accounts/messages.
 *
 * Run: node test/protocol-test.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- spawn an isolated server ---------------- */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sold-test-'));
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), SOLD_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
process.on('exit', () => { try { child.kill('SIGKILL'); } catch (_) {} });

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch (_) {}
    await sleep(150);
  }
  console.error('server did not start.\n' + childLog);
  cleanup(1);
}

class Client {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.waiters = [];
    this.socketId = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 5000);

      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (data[0] === '0') {
          try { this.socketId = JSON.parse(data.slice(1)).sid; } catch (_) {}
          ws.send('40');
          return;
        }
        if (data.startsWith('40')) { clearTimeout(timer); resolve(this); return; }
        if (data === '2') { ws.send('3'); return; }
        if (data[0] === '4' && data[1] === '2') {
          let payload;
          try { payload = JSON.parse(data.slice(2)); } catch (_) { return; }
          const [name, body] = payload;
          this.events.push({ name, body });
          this.waiters = this.waiters.filter((w) => {
            if (w.name !== name) return true;
            if (w.pred && !w.pred(body)) return true;
            clearTimeout(w.timer);
            w.resolve(body);
            return false;
          });
        }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${this.label}: ws error`)); });
      ws.addEventListener('close', () => this.events.push({ name: '__close' }));
    });
  }

  send(name, body) { this.ws.send(`42${JSON.stringify([name, body])}`); }

  waitFor(name, pred, timeout = 4000) {
    const existing = this.events.find((e) => e.name === name && (!pred || pred(e.body)));
    if (existing) return Promise.resolve(existing.body);
    return new Promise((resolve, reject) => {
      const waiter = { name, pred, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${this.label}: timed out waiting for "${name}"`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  has(name, pred) {
    return this.events.some((e) => e.name === name && (!pred || pred(e.body)));
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

async function api(route, body, method = 'POST') {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const silence = (ms) => sleep(ms);

async function main() {
  await waitForServer();

  /* ---------------- auth ---------------- */
  const runId = Date.now().toString(36);
  const aliceName = `alice-${runId}`;
  const bobName = `bob-${runId}`;
  const malloryName = `mallory-${runId}`;
  const password = 's3cret-pass';
  const helloText = `hello from Alice ${runId}`;

  const suAlice = await api('/api/signup', { username: aliceName, password });
  check('signup creates an account + token',
    suAlice.status === 200 && !!suAlice.data.token && suAlice.data.user?.username === aliceName,
    `status=${suAlice.status}`);

  const suDup = await api('/api/signup', { username: aliceName, password });
  check('duplicate signup rejected', suDup.status === 409, `status=${suDup.status}`);

  const badLogin = await api('/api/login', { username: aliceName, password: 'wrong-password' });
  check('wrong password rejected', badLogin.status === 401, `status=${badLogin.status}`);

  const liAlice = await api('/api/login', { username: aliceName, password });
  check('login returns a fresh token',
    liAlice.status === 200 && !!liAlice.data.token && liAlice.data.user?.username === aliceName,
    `status=${liAlice.status}`);

  const suBob = await api('/api/signup', { username: bobName, password });
  check('second account signup', suBob.status === 200 && !!suBob.data.token, `status=${suBob.status}`);

  /* ---------------- join (token required) ---------------- */
  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  await b.connect();
  check('both clients connect over websocket', true);

  a.send('join', { name: 'Mallory' }); // no token → must be rejected
  const rejected = await a.waitFor('join:error');
  check('join without a token is rejected', !!rejected.error, rejected.error);

  a.send('join', { token: liAlice.data.token });
  const initA0 = await a.waitFor('init');
  b.send('join', { token: suBob.data.token });
  const initB0 = await b.waitFor('init');
  check('fresh accounts start with no servers',
    Array.isArray(initA0.servers) && initA0.servers.length === 0 && initB0.servers.length === 0,
    `A=${initA0.servers?.length} servers, B=${initB0.servers?.length} servers`);

  /* ---------------- server creation + invite join ---------------- */
  const create = await api('/api/servers/create', { token: liAlice.data.token, name: 'Test Den' });
  check('create server returns an invite + 5 seeded channels',
    create.status === 200 && !!create.data.server?.invite && create.data.server.members.length === 1,
    `status=${create.status}`);
  const den = create.data.server;

  const initA = await a.waitFor('init', (i) => i.servers?.length === 1, 5000);
  check('creator gets re-init with the new server',
    initA.servers[0].id === den.id && initA.channels.length === 5,
    `${initA.channels.length} channels in ${initA.servers[0].name}`);

  const joinRes = await api('/api/servers/join', { token: suBob.data.token, invite: den.invite });
  check('second account joins via invite code',
    joinRes.status === 200 && joinRes.data.server.members.length === 2,
    `status=${joinRes.status}`);

  const initB = await b.waitFor(
    'init',
    (i) => i.servers?.length === 1,
    5000
  );
  check('invitee gets re-init with the server + channels',
    initB.servers[0].id === den.id && initB.channels.length === 5 && initB.users.length >= 2,
    `${initB.channels.length} channels, ${initB.users.length} visible users`);

  const badInvite = await api('/api/servers/join', { token: suBob.data.token, invite: 'deadbeef' });
  check('joining with a bogus invite is rejected', badInvite.status === 404, `status=${badInvite.status}`);

  const general = initA.channels.find((c) => c.type === 'text');
  check('server has a text channel', !!general, general?.name);

  /* ---------------- text chat (scoped to the server) ---------------- */
  a.send('text:open', { channelId: general.id });
  const histA = await a.waitFor('text:history');
  check('history is an array', Array.isArray(histA.messages));

  a.send('text:send', { channelId: general.id, text: helloText });
  const msg = await b.waitFor('text:message');
  check('message delivered to other member', msg.text === helloText && msg.name === initA.me.name,
    `from ${msg.name}`);

  a.send('typing', { channelId: general.id });
  const typing = await b.waitFor('typing');
  check('typing event relayed', typing.channelId === general.id);

  a.send('text:open', { channelId: general.id });
  const histA2 = await a.waitFor('text:history',
    (h) => h.messages.some((m) => m.text === helloText));
  check('message stored in history', histA2.messages.some((m) => m.text === helloText),
    `${histA2.messages.length} message(s)`);

  /* ---------------- emoji reactions ---------------- */
  b.send('text:react', { channelId: general.id, messageId: msg.id, emoji: '👍' });
  const reactOn = await a.waitFor('text:reaction', (r) => r.messageId === msg.id);
  check('reaction broadcast to members', (reactOn.reactions['👍'] || []).length === 1,
    JSON.stringify(reactOn.reactions));

  b.send('text:react', { channelId: general.id, messageId: msg.id, emoji: '👍' });
  const reactOff = await a.waitFor('text:reaction',
    (r) => r.messageId === msg.id && !r.reactions['👍']);
  check('reaction toggled off by the same user', !reactOff.reactions['👍'],
    JSON.stringify(reactOff.reactions));

  /* ---------------- channel creation (server-scoped) ---------------- */
  const suffix = Date.now().toString(36);
  const wanted = `my-new-room-${suffix}`;
  a.send('channel:create', { name: `My New Room ${suffix}`, type: 'voice', serverId: den.id });
  const channels = await b.waitFor('channels', (cs) => cs.some((c) => c.name === wanted));
  check('channel created & broadcast to members',
    channels.some((c) => c.name === wanted && c.type === 'voice' && c.serverId === den.id),
    channels.map((c) => c.name).join(', '));

  /* ---------------- voice join + relay ---------------- */
  const lobby = initA.channels.find((c) => c.type === 'voice');
  a.send('voice:join', { channelId: lobby.id });
  await a.waitFor('voice:update', (u) => u.some((p) => p.id === initA.me.id));
  b.send('voice:join', { channelId: lobby.id });
  const peers = await b.waitFor('voice:peers');
  check('joiner is told existing peers', peers.peers.some((p) => p.id === initA.me.id),
    `${peers.peers.length} peer(s), ids=${peers.peers.map((p) => p.id).join()}`);

  const update = await a.waitFor('voice:update', (u) => u.length === 2);
  check('voice participants broadcast', update.length === 2, `participants=${update.length}`);

  /* ---------------- signaling relay ---------------- */
  a.send('voice:signal', {
    to: initB.me.id,
    data: { description: { type: 'offer', sdp: 'v=0 test-sdp' } },
  });
  const sig = await b.waitFor('voice:signal', (s) => s.data.description?.type === 'offer');
  check('SDP offer relayed A -> B', sig.from === initA.me.id && sig.data.description.sdp === 'v=0 test-sdp');

  b.send('voice:signal', {
    to: initA.me.id,
    data: { description: { type: 'answer', sdp: 'v=0 answer-sdp' } },
  });
  const sig2 = await a.waitFor('voice:signal', (s) => s.data.description?.type === 'answer');
  check('SDP answer relayed B -> A', sig2.from === initB.me.id && sig2.data.description.type === 'answer');

  b.send('voice:signal', {
    to: initA.me.id,
    data: { candidate: { candidate: 'candidate:1 1 UDP 123 1.2.3.4 5000 typ host' } },
  });
  const sig3 = await a.waitFor('voice:signal', (s) => !!s.data.candidate);
  check('ICE candidate relayed', !!sig3.data.candidate.candidate);

  /* ---------------- voice state ---------------- */
  b.send('voice:state', { audio: false, video: true, screen: true });
  const stateUpdate = await a.waitFor('voice:update', (u) => u.some((p) => p.id === initB.me.id && p.audio === false));
  const bobInVoice = stateUpdate.find((p) => p.id === initB.me.id);
  check('voice state (mute/camera/screen) broadcast', bobInVoice.audio === false && bobInVoice.video === true && bobInVoice.screen === true);

  /* ---------------- cross-server isolation ---------------- */
  const suMallory = await api('/api/signup', { username: malloryName, password });
  const m = new Client('M');
  await m.connect();
  m.send('join', { token: suMallory.data.token });
  const initM = await m.waitFor('init');
  check('outsider sees zero servers and channels',
    initM.servers.length === 0 && initM.channels.length === 0,
    `${initM.servers.length} servers`);

  m.send('text:open', { channelId: general.id }); // knows the id — must still be denied
  await silence(700);
  check('outsider cannot open the channel history',
    !m.has('text:history'), 'no history leaked');

  m.send('text:send', { channelId: general.id, text: 'i should not get in' });
  await silence(700);
  check('outsider cannot post to the channel',
    !a.has('text:message', (msg) => msg.text === 'i should not get in')
    && !b.has('text:message', (msg) => msg.text === 'i should not get in'),
    'message blocked');

  m.send('voice:join', { channelId: lobby.id });
  await silence(700);
  check('outsider cannot join the voice room',
    !m.has('voice:peers') && !a.has('voice:update', (u) => u.some((p) => p.id === initM.me.id)),
    'voice join blocked');

  /* ---------------- friends + DMs ---------------- */
  const dmKey = `dm:${[aliceName.toLowerCase(), bobName.toLowerCase()].sort().join('::')}`;

  m.send('text:open', { channelId: dmKey });
  m.send('text:send', { channelId: dmKey, text: 'let me in' });
  await silence(700);
  check('non-friend cannot open or post into the DM',
    !m.has('text:history')
    && !a.has('text:message', (x) => x.text === 'let me in')
    && !b.has('text:message', (x) => x.text === 'let me in'),
    'blocked before friendship');

  const fr = await api('/api/friends/request', { token: liAlice.data.token, username: bobName });
  check('friend request returns requested + outgoing shows up',
    fr.status === 200 && fr.data.status === 'requested'
    && fr.data.friends.outgoing.some((r) => r.username === bobName.toLowerCase()),
    `status=${fr.status}`);

  const bobIncoming = await b.waitFor('friends', (f) => f.incoming.length === 1);
  check('requested user gets a friends push with the incoming request',
    bobIncoming.incoming[0].username === aliceName.toLowerCase(),
    JSON.stringify(bobIncoming.incoming));

  const dupFr = await api('/api/friends/request', { token: liAlice.data.token, username: bobName });
  check('duplicate request is rejected', dupFr.status === 409, `status=${dupFr.status}`);

  const respond = await api('/api/friends/respond', { token: suBob.data.token, username: aliceName, accept: true });
  check('accepting makes both sides friends',
    respond.status === 200 && respond.data.friends.friends.some((f) => f.username === aliceName.toLowerCase()),
    `status=${respond.status}`);

  await a.waitFor('friends', (f) => f.friends.length === 1);
  check('requester gets friends push on accept', a.has('friends', (f) => f.friends.length === 1));

  a.send('text:open', { channelId: dmKey });
  const dmHist = await a.waitFor('text:history', (h) => h.channelId === dmKey);
  check('DM thread opens with history', Array.isArray(dmHist.messages), `${dmHist.messages.length} msgs`);

  a.send('text:send', { channelId: dmKey, text: `dm hello ${runId}` });
  const dmMsg = await b.waitFor('text:message', (x) => x.channelId === dmKey);
  check('DM delivered to the friend', dmMsg.text === `dm hello ${runId}`);

  b.send('typing', { channelId: dmKey });
  const dmTyping = await a.waitFor('typing', (t) => t.channelId === dmKey);
  check('typing relayed inside the DM', dmTyping.name === initB.me.name);

  b.send('text:react', { channelId: dmKey, messageId: dmMsg.id, emoji: '👍' });
  const dmReact = await a.waitFor('text:reaction', (r) => r.channelId === dmKey && r.messageId === dmMsg.id);
  check('reactions work in DMs', (dmReact.reactions['👍'] || []).length === 1,
    JSON.stringify(dmReact.reactions));

  m.send('text:react', { channelId: dmKey, messageId: dmMsg.id, emoji: '😂' });
  await silence(700);
  check('non-friend cannot react in the DM',
    !a.has('text:reaction', (r) => r.messageId === dmMsg.id && r.reactions['😂']),
    'reaction blocked');

  await a.waitFor('dms', (l) => l.some((d) => d.key === dmKey));
  check('DM summaries pushed after a message', a.has('dms', (l) => l.some((d) => d.key === dmKey)));

  check('dms.json persisted with the thread',
    (() => {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dms.json'), 'utf8'));
        return !!(saved.threads && saved.threads[dmKey]);
      } catch (_) { return false; }
    })());

  const remove = await api('/api/friends/remove', { token: liAlice.data.token, username: bobName });
  check('unfriend succeeds', remove.status === 200 && remove.data.ok, `status=${remove.status}`);

  await silence(400);
  b.send('text:open', { channelId: dmKey });
  await silence(700);
  check('after unfriend the DM is locked again',
    !b.has('text:history', (h) => h.channelId === dmKey), 'dm closed');

  const reRequest = await api('/api/friends/request', { token: liAlice.data.token, username: bobName });
  await api('/api/friends/respond', { token: suBob.data.token, username: aliceName, accept: true });
  check('re-friending works after removal',
    reRequest.status === 200 && reRequest.data.status === 'requested',
    `status=${reRequest.status}`);

  /* ---------------- leave + rejoin ---------------- */
  b.send('voice:leave');
  const leave = await a.waitFor('voice:leave');
  check('voice:leave notified to peers', leave.peerId === initB.me.id);

  const leaveRes = await api('/api/servers/leave', { token: suBob.data.token, serverId: den.id });
  check('member can leave the server', leaveRes.status === 200, `status=${leaveRes.status}`);
  const initB2 = await b.waitFor('init', (i) => (i.servers?.length ?? 1) === 0, 5000);
  check('leaver loses the server and its channels',
    initB2.servers.length === 0 && initB2.channels.length === 0,
    `${initB2.channels.length} channels left`);

  const rejoin = await api('/api/servers/join', { token: suBob.data.token, invite: den.invite });
  check('leaver can rejoin with the invite', rejoin.status === 200, `status=${rejoin.status}`);
  await b.waitFor('init', (i) => i.servers?.length === 1, 5000);

  b.close();
  await a.waitFor('users', (u) => u.length === 1);
  check('disconnect removes user', true);

  a.close();
  m.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cleanup(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('TEST ERROR:', err.message);
  cleanup(1);
});
