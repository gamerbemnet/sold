/* Functional test for the Sold server using raw Engine.IO/Socket.IO
 * protocol over Node's built-in WebSocket (no extra dependencies).
 *
 * Run: node test/protocol-test.mjs
 */

const URL = 'ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
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
      const ws = new WebSocket(URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 5000);

      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (data[0] === '0') {
          try { this.socketId = JSON.parse(data.slice(1)).sid; } catch (_) {}
          ws.send('40');                       // connect to default namespace
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

async function main() {
  /* ---------------- auth ---------------- */
  const runId = Date.now().toString(36);
  const aliceName = `alice-${runId}`;
  const bobName = `bob-${runId}`;
  const password = 's3cret-pass';

  async function api(route, body) {
    const res = await fetch(`http://127.0.0.1:3000${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

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

  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  await b.connect();
  check('both clients connect over websocket', true);

  /* ---------------- join (token required) ---------------- */
  a.send('join', { name: 'Mallory' }); // no token → must be rejected
  const rejected = await a.waitFor('join:error');
  check('join without a token is rejected', !!rejected.error, rejected.error);

  a.send('join', { token: liAlice.data.token }); // signed-in Alice
  b.send('join', { token: suBob.data.token });   // just-signed-up Bob
  const initA = await a.waitFor('init');
  const initB = await b.waitFor('init');
  check('init payload has channels', Array.isArray(initA.channels) && initA.channels.length >= 5,
    `${initA.channels.length} channels`);
  check('init reports me + users', !!initA.me?.name && Array.isArray(initB.users) && initB.users.length === 2,
    `users=${initB.users.length}`);
  check('signed-in usernames are used', initA.me.name === aliceName && initB.me.name === bobName,
    `A=${initA.me.name} B=${initB.me.name}`);

  /* ---------------- text chat ---------------- */
  const general = initA.channels.find((c) => c.type === 'text');
  a.send('text:open', { channelId: general.id });
  const histA = await a.waitFor('text:history');
  check('history is an array', Array.isArray(histA.messages));

  a.send('text:send', { channelId: general.id, text: 'hello from Alice' });
  const msg = await b.waitFor('text:message');
  check('message delivered to other client', msg.text === 'hello from Alice' && msg.name === initA.me.name,
    `from ${msg.name}`);

  a.send('typing', { channelId: general.id });
  const typing = await b.waitFor('typing');
  check('typing event relayed', typing.channelId === general.id);

  a.send('text:open', { channelId: general.id });
  const histA2 = await a.waitFor('text:history', (h) => h.messages.length > 0);
  check('message stored in history', histA2.messages.some((m) => m.text === 'hello from Alice'),
    `${histA2.messages.length} message(s)`);

  /* ---------------- channel creation ---------------- */
  const suffix = Date.now().toString(36);
  const wanted = `my-new-room-${suffix}`;
  a.send('channel:create', { name: `My New Room ${suffix}`, type: 'voice' });
  const channels = await b.waitFor('channels', (cs) => cs.some((c) => c.name === wanted));
  check('channel created & broadcast',
    channels.some((c) => c.name === wanted && c.type === 'voice'),
    channels.map((c) => c.name).join(', '));

  /* ---------------- voice join + relay ---------------- */
  const lobby = initA.channels.find((c) => c.type === 'voice');
  a.send('voice:join', { channelId: lobby.id });
  await a.waitFor('voice:update');
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
  const bob = stateUpdate.find((p) => p.id === initB.me.id);
  check('voice state (mute/camera/screen) broadcast', bob.audio === false && bob.video === true && bob.screen === true);

  /* ---------------- leave + disconnect ---------------- */
  b.send('voice:leave');
  const leave = await a.waitFor('voice:leave');
  check('voice:leave notified to peers', leave.peerId === initB.me.id);

  b.close();
  await a.waitFor('users', (u) => u.length === 1);
  check('disconnect removes user', true);

  a.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('TEST ERROR:', err.message);
  process.exit(1);
});
