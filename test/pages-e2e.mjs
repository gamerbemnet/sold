/* End-to-end test of the DEPLOYED site and backend:
 *   - soldchats.pages.dev (static UI, no worker proxy anymore)
 *   - the Cloudflare Worker backend (SSE in via /api/events, HTTP POST out via /api/action)
 *
 * Run: node test/pages-e2e.mjs
 *      PAGES_URL=https://soldchats.pages.dev API_URL=https://sold-backend.soldforums.workers.dev node test/pages-e2e.mjs
 *
 * Creates two throwaway accounts (alice-… / bob-…) and a server; prune them
 * afterwards via /api/admin/export|import if you care about the live data.
 */

import https from 'node:https';

/* Plain-https request helper. We deliberately do NOT use global fetch here:
 * Node's undici pools by origin and blocks on the long-lived SSE responses
 * (subsequent requests stall forever), while node:https opens independent
 * connections. */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(urlStr, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const BASE = (process.env.PAGES_URL || 'https://soldchats.pages.dev').replace(/\/+$/, '');
const API = (process.env.API_URL || 'https://sold-backend.soldforums.workers.dev').replace(/\/+$/, '');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Minimal SSE client over node:https. Parses `id:` / `data:` frames and
 * dispatches { n, b } payloads like the browser. */
class SseClient {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.waiters = [];
    this.clientId = `e2e-${label}-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    this.seq = 0;
    this.req = null;
    this.buf = '';
    this.closed = false;
  }

  connect(token) {
    return new Promise((resolve, reject) => {
      const url = `${API}/api/events?token=${encodeURIComponent(token)}&clientId=${this.clientId}&since=-1`;
      this.req = https.request(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      }, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(`${this.label}: /api/events -> ${res.statusCode} ${Buffer.concat(chunks)}`)));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => { this.buf += chunk; this.#drain(); });
        res.on('end', () => { this.closed = true; });
        res.on('error', () => { this.closed = true; });
      });
      this.req.on('error', (err) => { if (!this.closed) reject(err); this.closed = true; });
      this.req.end();
      this.waitFor('hello', null, 15000).then(() => resolve(this), reject);
    });
  }

  #drain() {
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.#handleFrame(raw);
    }
  }

  #handleFrame(raw) {
    let data = null;
    let id = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data = (data ? data + '\n' : '') + line.slice(5).replace(/^ /, '');
    }
    if (id != null) {
      const n = Number(id);
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
    }
    if (!data) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && msg.n) this.#dispatch(msg.n, msg.b);
  }

  #dispatch(name, body) {
    this.events.push({ name, body });
    this.waiters = this.waiters.filter((w) => {
      if (w.name !== name) return true;
      if (w.pred && !w.pred(body)) return true;
      clearTimeout(w.timer);
      w.resolve(body);
      return false;
    });
  }

  async action(token, name, body) {
    const res = await rawRequest(`${API}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, clientId: this.clientId, n: name, b: body || {} }),
    });
    return res;
  }

  waitFor(name, pred, timeout = 8000) {
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

  close() {
    try { this.req?.destroy(); } catch (_) {}
    this.closed = true;
  }
}

async function main() {
  console.log(`static: ${BASE}\nbackend: ${API}\n`);
  const runId = Date.now().toString(36);
  const aliceName = `alice-${runId}`;
  const bobName = `bob-${runId}`;
  const password = 's3cret-pass';

  async function api(route, body, method = 'POST') {
    const res = await rawRequest(`${API}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? null : JSON.stringify(body || {}),
    });
    let data = null;
    try { data = JSON.parse(res.body); } catch (_) {}
    return { status: res.status, data };
  }

  /* ------------- static assets (served by Pages, no proxy) -------------- */
  const idx = await rawRequest(`${BASE}/`);
  const html = idx.body;
  check('home page serves', idx.status === 200 && html.includes('Sold'), `status=${idx.status}`);

  check('socket.io reference is gone', !html.includes('socket.io'));

  check('DM-first home view is deployed',
    html.includes('id="friends-panel"') && html.includes('id="dm-list"') && html.includes('id="home-btn"'),
    'friends panel + DM list present in served HTML');

  check('change-password UI is deployed',
    html.includes('id="password-overlay"') && html.includes('id="panel-password"'),
    'key button + modal present');

  const css = await rawRequest(`${BASE}/style.css`);
  check('static asset (style.css) serves', css.status === 200 &&
    (css.headers['content-type'] || '').includes('text/css'),
    `${css.status} ${css.headers['content-type']}`);

  const js = await rawRequest(`${BASE}/app.js`);
  const jsText = js.body;
  check('app.js points at the Workers backend', js.status === 200 &&
    jsText.includes('sold-backend.soldforums.workers.dev') && jsText.includes('/api/events'),
    `status=${js.status}`);

  /* ------------- backend basics ----------------------------------------- */
  const health = await rawRequest(`${API}/api/health`);
  let healthData = null;
  try { healthData = JSON.parse(health.body); } catch (_) {}
  check('/api/health', health.status === 200 && healthData?.ok === true, `status=${health.status}`);

  const preflight = await rawRequest(`${API}/api/action`, {
    method: 'OPTIONS',
    headers: { Origin: BASE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  check('CORS preflight allows the Pages origin',
    preflight.headers['access-control-allow-origin'] === '*',
    `allow-origin=${preflight.headers['access-control-allow-origin']} status=${preflight.status}`);

  const turn = await rawRequest(`${API}/api/turn`);
  let turnData = null;
  try { turnData = JSON.parse(turn.body); } catch (_) {}
  check('TURN credentials served', turn.status === 200 &&
    Array.isArray(turnData?.urls) && turnData.urls.some((u) => u.startsWith('turn:')),
    `${turn.status}, ${turnData?.urls?.length ?? 0} urls`);

  /* ------------- auth ---------------------------------------------------- */
  const su = await api('/api/signup', { username: aliceName, password });
  check('signup alice', su.status === 200 && !!su.data.token, `status=${su.status}`);

  const bad = await api('/api/login', { username: aliceName, password: 'wrong' });
  check('wrong password rejected', bad.status === 401, `status=${bad.status}`);

  const li = await api('/api/login', { username: aliceName, password });
  check('login alice', li.status === 200 && !!li.data.token, `status=${li.status}`);

  const suBob = await api('/api/signup', { username: bobName, password });
  check('signup bob', suBob.status === 200 && !!suBob.data.token, `status=${suBob.status}`);

  // servers: alice creates one, bob joins via invite (shared room)
  const create = await api('/api/servers/create', { token: li.data.token, name: 'Pages E2E Lab' });
  check('create server', create.status === 200 && !!create.data.server?.invite, `status=${create.status}`);
  const joinRes = await api('/api/servers/join', { token: suBob.data.token, invite: create.data.server?.invite });
  check('second account joins via invite', joinRes.status === 200, `status=${joinRes.status}`);

  /* ------------- SSE transport ------------------------------------------- */
  const a = new SseClient('A');
  const b = new SseClient('B');
  await a.connect(li.data.token);
  await b.connect(suBob.data.token);
  check('SSE streams connect (hello from both)', true);

  const badJoin = await a.action('bogus-token', 'text:send', { channelId: 'x', text: 'hi' });
  check('action with bad token rejected', badJoin.status === 401, `status=${badJoin.status}`);

  const bootA = await api(`/api/bootstrap?token=${encodeURIComponent(li.data.token)}&clientId=${a.clientId}`, null, 'GET');
  check('bootstrap alice', bootA.status === 200 && bootA.data.me?.username === aliceName.toLowerCase() &&
    bootA.data.channels.length >= 5, `status=${bootA.status}`);
  const bootB = await api(`/api/bootstrap?token=${encodeURIComponent(suBob.data.token)}&clientId=${b.clientId}`, null, 'GET');
  check('bootstrap bob sees 2+ users', bootB.status === 200 && bootB.data.users.length >= 2,
    `${bootB.data?.users?.length} users`);

  /* ------------- real-time chat ------------------------------------------ */
  const general = bootA.data.channels.find((c) => c.type === 'text');
  await a.action(li.data.token, 'text:send', { channelId: general.id, text: 'hello from e2e' });
  const msg = await b.waitFor('text:message', (m) => m.channelId === general.id);
  check('message relayed over SSE', msg.text === 'hello from e2e' && msg.name === aliceName,
    `from ${msg.name}`);

  await a.action(li.data.token, 'typing', { channelId: general.id });
  const typing = await b.waitFor('typing');
  check('typing relayed over SSE', typing.channelId === general.id);

  await b.action(suBob.data.token, 'text:react', { channelId: general.id, messageId: msg.id, emoji: '🎉' });
  const react = await a.waitFor('text:reaction', (r) => r.messageId === msg.id);
  check('emoji reaction relayed over SSE', (react.reactions?.['🎉'] || []).length === 1,
    JSON.stringify(react.reactions));

  /* ------------- voice signaling (WebRTC relay path) ---------------------- */
  const lobby = bootA.data.channels.find((c) => c.type === 'voice');
  await a.action(li.data.token, 'voice:join', { channelId: lobby.id });
  await a.waitFor('voice:update', (u) => Array.isArray(u) && u.some((p) => p.id === a.clientId));
  await b.action(suBob.data.token, 'voice:join', { channelId: lobby.id });
  const peers = await b.waitFor('voice:peers');
  check('voice join relayed (peer discovery)', Array.isArray(peers.peers) &&
    peers.peers.some((p) => p.id === a.clientId), `${peers.peers?.length ?? 0} peer(s)`);

  const fakeSdp = { kind: 'offer', sdp: 'v=0 e2e-test-signal' };
  await b.action(suBob.data.token, 'voice:signal', { to: a.clientId, data: fakeSdp });
  const sig = await a.waitFor('voice:signal');
  check('SDP/ICE signal relayed over SSE', sig.from === b.clientId && sig.to === a.clientId &&
    sig.data?.sdp === fakeSdp.sdp, `from ${sig.from}`);

  /* ------------- password endpoint (wrong current only — no mutation) ------ */
  const wrongPw = await api('/api/account/password', {
    token: li.data.token, currentPassword: 'not-the-password', newPassword: 'whatever-1',
  });
  check('change password rejects wrong current password', wrongPw.status === 400 || wrongPw.status === 401,
    `status=${wrongPw.status}`);

  /* ------------- friends + DMs -------------------------------------------- */
  const fr = await api('/api/friends/request', { token: li.data.token, username: bobName });
  check('friend request sent', fr.status === 200 && fr.data.status === 'requested', `status=${fr.status}`);

  const incoming = await b.waitFor('friends', (f) => Array.isArray(f.incoming) && f.incoming.length === 1);
  check('friend request reaches the other live over SSE',
    incoming.incoming[0].username === aliceName.toLowerCase());

  const accept = await api('/api/friends/respond', { token: suBob.data.token, username: aliceName, accept: true });
  check('friend accept', accept.status === 200 && accept.data.status === 'accepted', `status=${accept.status}`);

  const dmKey = `dm:${[aliceName.toLowerCase(), bobName.toLowerCase()].sort().join('::')}`;
  await a.action(li.data.token, 'text:send', { channelId: dmKey, text: 'hello over live DMs' });
  const dmMsg = await b.waitFor('text:message', (x) => x.channelId === dmKey);
  check('DM relayed over SSE', dmMsg.text === 'hello over live DMs');

  const dmHist = await api(
    `/api/history?token=${encodeURIComponent(suBob.data.token)}&channelId=${encodeURIComponent(dmKey)}`,
    null, 'GET');
  check('DM history readable via /api/history',
    dmHist.status === 200 && dmHist.data?.messages?.some((m) => m.text === 'hello over live DMs'),
    `${dmHist.data?.messages?.length ?? 0} msg(s), status=${dmHist.status}`);

  const hb = await a.action(li.data.token, 'heartbeat', {});
  check('heartbeat action accepted', hb.status === 200, `status=${hb.status}`);

  /* ------------- media: avatars, banners, profile card ------------- */
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const mediaPost = (route, buf, type) => rawRequest(`${API}${route}`, {
    method: 'POST',
    headers: type ? { 'Content-Type': type } : {},
    body: buf,
  });

  const avUp = await mediaPost(`/api/account/avatar?token=${encodeURIComponent(li.data.token)}`, png, 'image/png');
  let avStamp = 0;
  try { avStamp = (JSON.parse(avUp.body) || {}).avatarAt || 0; } catch (_) {}
  check('avatar upload round-trips', avUp.status === 200 && avStamp > 0, `status=${avUp.status}`);

  const avGet = await rawRequest(`${API}/api/avatar/${aliceName}?v=${avStamp}`);
  check('avatar served as image/png', avGet.status === 200 && String(avGet.headers['content-type'] || '').includes('image/png') && avGet.body.length > 0,
    `status=${avGet.status} type=${avGet.headers['content-type']}`);

  const sbUp = await mediaPost(`/api/servers/banner?token=${encodeURIComponent(li.data.token)}&serverId=${encodeURIComponent(create.data.server?.id)}`, png, 'image/png');
  let sbStamp = 0;
  try { sbStamp = (JSON.parse(sbUp.body) || {}).bannerAt || 0; } catch (_) {}
  check('server banner upload (owner)', sbUp.status === 200 && sbStamp > 0, `status=${sbUp.status}`);

  const sbEvil = await mediaPost(`/api/servers/banner?token=${encodeURIComponent(suBob.data.token)}&serverId=${encodeURIComponent(create.data.server?.id)}`, png, 'image/png');
  check('server banner upload rejected for non-owner', sbEvil.status === 403, `status=${sbEvil.status}`);

  const sbGet = await rawRequest(`${API}/api/server-banner/${create.data.server?.id}?v=${sbStamp}`);
  check('server banner served', sbGet.status === 200 && String(sbGet.headers['content-type'] || '').includes('image/png'), `status=${sbGet.status}`);

  const profRes = await rawRequest(`${API}/api/profile?token=${encodeURIComponent(suBob.data.token)}&username=${aliceName}`);
  let prof = null;
  try { prof = JSON.parse(profRes.body); } catch (_) {}
  check('profile card (friend view) carries media + relation',
    profRes.status === 200 && prof && prof.relation === 'friend' && prof.avatarAt > 0,
    `relation=${prof?.relation} avatarAt=${prof?.avatarAt}`);

  const avDel = await rawRequest(`${API}/api/account/avatar?token=${encodeURIComponent(li.data.token)}`, { method: 'DELETE' });
  const sbDel = await rawRequest(`${API}/api/servers/banner?token=${encodeURIComponent(li.data.token)}&serverId=${encodeURIComponent(create.data.server?.id)}`, { method: 'DELETE' });
  const avGone = await rawRequest(`${API}/api/avatar/${aliceName}`);
  check('avatar + server banner deleted', avDel.status === 200 && sbDel.status === 200 && avGone.status === 404,
    `${avDel.status}/${sbDel.status}/${avGone.status}`);

  a.close();
  b.close();
  // let the worker notice the disconnects and clear presence
  await sleep(2500);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nFAIL  ${err.message}`);
  process.exit(1);
});
