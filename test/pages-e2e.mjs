/* End-to-end test of the DEPLOYED Cloudflare Pages site:
 * static assets -> worker proxy -> origin tunnel -> Node server,
 * including WebSocket transport (real-time chat + voice signaling).
 *
 * Run: node test/pages-e2e.mjs [https://<project>.pages.dev]
 */

const BASE = (process.argv[2] || process.env.PAGES_URL || 'https://sold-3e0.pages.dev').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const WS_URL = `${WS_BASE}/socket.io/?EIO=4&transport=websocket`;

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Client {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.waiters = [];
    this.socketId = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 10000);

      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (data[0] === '0') {
          try { this.socketId = JSON.parse(data.slice(1)).sid; } catch (_) {}
          ws.send('40');                          // connect to default namespace
          return;
        }
        if (data.startsWith('40')) { clearTimeout(timer); resolve(this); return; }
        if (data === '2') { ws.send('3'); return; }   // engine.io ping -> pong
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

  waitFor(name, pred, timeout = 6000) {
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

  close() { try { this.ws.close(); } catch (_) {} }
}

async function main() {
  console.log(`target: ${BASE}\n`);
  const runId = Date.now().toString(36);
  const aliceName = `alice-${runId}`;
  const password = 's3cret-pass';

  async function api(route, body) {
    const res = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  /* ---------------- static assets (served by Pages, not the origin) ------- */
  const idx = await fetch(`${BASE}/`);
  const html = await idx.text().catch(() => '');
  check('home page serves', idx.status === 200 && html.includes('Sold'),
    `status=${idx.status}`);

  const css = await fetch(`${BASE}/style.css`);
  check('static asset (style.css) serves', css.status === 200 &&
    (css.headers.get('content-type') || '').includes('text/css'),
    `${css.status} ${css.headers.get('content-type')}`);

  /* ---------------- worker proxy to the origin ---------------------------- */
  const sj = await fetch(`${BASE}/socket.io/socket.io.js`);
  check('socket.io client script proxied', sj.status === 200, `status=${sj.status}`);

  const turn = await fetch(`${BASE}/api/turn`);
  let turnData = null;
  try { turnData = await turn.json(); } catch (_) {}
  check('TURN credentials proxied', turn.status === 200 &&
    Array.isArray(turnData?.urls) && turnData.urls.some((u) => u.startsWith('turn:')),
    `${turn.status}, ${turnData?.urls?.length ?? 0} urls`);

  /* ---------------- auth through Pages ------------------------------------ */
  const su = await api('/api/signup', { username: aliceName, password });
  check('signup through Pages', su.status === 200 && !!su.data.token, `status=${su.status}`);

  const bad = await api('/api/login', { username: aliceName, password: 'wrong' });
  check('wrong password rejected', bad.status === 401, `status=${bad.status}`);

  const li = await api('/api/login', { username: aliceName, password });
  check('login through Pages', li.status === 200 && !!li.data.token, `status=${li.status}`);

  /* ---------------- websocket transport ----------------------------------- */
  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  await b.connect();
  check('websocket connects through Pages', true);

  a.send('join', { name: 'Mallory' }); // no token -> must still be rejected
  const rejected = await a.waitFor('join:error');
  check('join without token rejected through Pages', !!rejected.error, rejected.error);

  a.send('join', { token: li.data.token });
  b.send('join', { token: su.data.token });
  const initA = await a.waitFor('init');
  const initB = await b.waitFor('init');
  check('join + init over websocket', Array.isArray(initA.channels) && initA.channels.length >= 5 &&
    initB.users.length === 2, `${initA.channels.length} channels, ${initB.users.length} users`);

  /* ---------------- real-time chat ---------------------------------------- */
  const general = initA.channels.find((c) => c.type === 'text');
  a.send('text:send', { channelId: general.id, text: 'hello from Pages' });
  const msg = await b.waitFor('text:message');
  check('message relayed through Pages', msg.text === 'hello from Pages' && msg.name === aliceName,
    `from ${msg.name}`);

  a.send('typing', { channelId: general.id });
  const typing = await b.waitFor('typing');
  check('typing relayed through Pages', typing.channelId === general.id);

  /* ---------------- voice signaling (WebRTC relay path) -------------------- */
  const lobby = initA.channels.find((c) => c.type === 'voice');
  a.send('voice:join', { channelId: lobby.id });
  await a.waitFor('voice:update');
  b.send('voice:join', { channelId: lobby.id });
  const peers = await b.waitFor('voice:peers');
  check('voice join relayed (peer discovery)', peers.peers.some((p) => p.id === initA.me.id),
    `${peers.peers.length} peer(s)`);

  const fakeSdp = { kind: 'offer', sdp: 'v=0 test-through-pages' };
  b.send('voice:signal', { to: initA.me.id, data: fakeSdp });
  const sig = await a.waitFor('voice:signal');
  check('SDP/ICE signal relayed through Pages', sig.from === initB.me.id &&
    sig.data?.sdp === fakeSdp.sdp, `from ${sig.from}`);

  a.close();
  b.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nFAIL  ${err.message}`);
  process.exit(1);
});
