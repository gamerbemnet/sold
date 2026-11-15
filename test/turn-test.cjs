/* Minimal TURN client (long-term credential mechanism) to verify a free
 * TURN server actually allocates a relay address.
 *
 * Usage: node test/turn-test.cjs <host> <port> <username> <credential> [tcp|udp]
 */
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const [host, portArg, username, credential, proto = 'udp'] = process.argv.slice(2);
if (!host) {
  console.log('usage: node test/turn-test.cjs <host> <port> <user> <pass> [tcp|udp]');
  process.exit(2);
}
const port = Number(portArg) || 3478;
const MAGIC = 0x2112a442;

function txid() {
  const b = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

function attr(type, value) {
  const len = value.length;
  const pad = (4 - (len % 4)) % 4;
  const b = Buffer.alloc(4 + len + pad);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(len, 2);
  value.copy(b, 4);
  return b;
}

function buildMessage(type, attrs, id) {
  const body = Buffer.concat(attrs);
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(body.length, 2);
  h.writeUInt32BE(MAGIC, 4);
  id.copy(h, 8);
  return Buffer.concat([h, body]);
}

function withMessageIntegrity(msg, user, realm, pass) {
  const key = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest();
  // length field covers everything through MI (4-byte header + 20-byte hash)
  const withLen = Buffer.from(msg);
  withLen.writeUInt16BE(withLen.length - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(withLen).digest();
  const mi = attr(0x0008, mac);
  return Buffer.concat([withLen, mi]);
}

function parse(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const attrs = {};
  let off = 20;
  while (off + 4 <= buf.length) {
    const t = buf.readUInt16BE(off);
    const l = buf.readUInt16BE(off + 2);
    attrs[t] = buf.slice(off + 4, off + 4 + l);
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return { type, attrs };
}

function xorAddr(buf) {
  const port = buf.readUInt16BE(0) ^ (MAGIC >>> 16);
  const v4 = buf.slice(4, 8);
  const ip = [...v4].map((n, i) => n ^ [(MAGIC >> 24) & 0xff, (MAGIC >> 16) & 0xff, (MAGIC >> 8) & 0xff, MAGIC & 0xff][i]).join('.');
  return `${ip}:${port}`;
}

function allocateMessage(id) {
  return buildMessage(0x0003, [attr(0x0019, Buffer.from([17, 0, 0, 0]))], id); // REQUESTED-TRANSPORT=UDP (4 bytes)
}

function authenticatedAllocate(id, realm, nonce) {
  const id2 = txid();
  const base = buildMessage(0x0003, [
    attr(0x0006, Buffer.from(username, 'utf8')),  // USERNAME
    attr(0x0014, Buffer.from(realm, 'utf8')),      // REALM
    attr(0x0015, Buffer.from(nonce, 'utf8')),      // NONCE
    attr(0x0019, Buffer.from([17, 0, 0, 0])),      // REQUESTED-TRANSPORT
  ], id2);
  return { msg: withMessageIntegrity(base, username, realm, credential), id: id2 };
}

function describe(r) {
  if (!r) return 'unparsable';
  const names = { 0x0103: 'allocated(SUCCESS)', 0x0113: 'allocate-error', 0x0101: 'binding-success', 0x0111: 'binding-error', 0x01031: 'x' };
  let out = names[r.type] || `type=0x${r.type.toString(16)}`;
  if (r.attrs[0x0020]) out += ` xorRelayed=${xorAddr(r.attrs[0x0020])}`;
  if (r.attrs[0x0014]) out += ` realm="${r.attrs[0x0014].toString()}"`;
  if (r.attrs[0x0015]) out += ` nonce=yes(${r.attrs[0x0015].length}b)`;
  if (r.attrs[0x0009]) {
    const v = r.attrs[0x0009];
    out += ` errorCode=${v[2] * 100 + v[3]} "${v.slice(4).toString()}"`;
  }
  out += ' attrs=[' + Object.keys(r.attrs).map((k) => '0x' + Number(k).toString(16)).join(',') + ']';
  return out;
}

async function run() {
  const id = txid();
  const first = allocateMessage(id);

  if (proto === 'udp') {
    const sock = dgram.createSocket('udp4');
    const ask = (msg) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 6000);
        const onMsg = (m) => { clearTimeout(t); sock.removeListener('error', onErr); resolve(m); };
        const onErr = (e) => { clearTimeout(t); reject(e); };
        sock.once('message', onMsg);
        sock.once('error', onErr);
        sock.send(msg, port, host);
      });

    console.log(`[udp] ${host}:${port} allocate ->`, describe(parse(await ask(first))));
    const r1 = parse(await ask(first).catch(() => null));
    if (r1 && (r1.type === 0x0103 || r1.attrs[0x0015])) {
      const realm = r1.attrs[0x0014]?.toString() || host;
      const nonce = r1.attrs[0x0015]?.toString();
      const auth = authenticatedAllocate(id, realm, nonce);
      const r2 = parse(await ask(auth.msg));
      console.log(`[udp] authenticated allocate ->`, describe(r2));
      const ok = r2 && r2.type === 0x0103;
      sock.close();
      console.log(ok ? 'TURN ALLOCATION OK ✅' : 'TURN ALLOCATION FAILED ❌');
      process.exit(ok ? 0 : 1);
    }
    sock.close();
    console.log('no 401/nonce received — server is not a TURN allocator ❌');
    process.exit(1);
  } else {
    // TURN over TCP: 2-byte length prefix per message
    const sock = net.connect({ host, port });
    await new Promise((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
      setTimeout(() => rej(new Error('tcp connect timeout')), 6000);
    });
    let buf = Buffer.alloc(0);
    const send = (msg) => sock.write(Buffer.concat([Buffer.from([msg.length >> 8, msg.length & 0xff]), msg]));
    const nextMsg = () =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 6000);
        const tryParse = () => {
          if (buf.length >= 2) {
            const l = (buf[0] << 8) | buf[1];
            if (buf.length >= 2 + l) {
              const m = buf.slice(2, 2 + l);
              buf = buf.slice(2 + l);
              clearTimeout(t);
              resolve(m);
              return true;
            }
          }
          return false;
        };
        if (tryParse()) return;
        const onData = (d) => { buf = Buffer.concat([buf, d]); tryParse(); };
        sock.on('data', onData);
        sock.once('error', (e) => { clearTimeout(t); reject(e); });
      });

    send(first);
    const r1 = parse(await nextMsg());
    console.log(`[tcp] ${host}:${port} allocate ->`, describe(r1));
    if (r1 && r1.attrs[0x0015]) {
      const realm = r1.attrs[0x0014]?.toString() || host;
      const nonce = r1.attrs[0x0015]?.toString();
      const auth = authenticatedAllocate(id, realm, nonce);
      send(auth.msg);
      const r2 = parse(await nextMsg());
      console.log(`[tcp] authenticated allocate ->`, describe(r2));
      const ok = r2 && r2.type === 0x0103;
      console.log(ok ? 'TURN ALLOCATION OK ✅' : 'TURN ALLOCATION FAILED ❌');
      sock.end();
      process.exit(ok ? 0 : 1);
    }
    console.log('no nonce received — not a TURN allocator ❌');
    sock.end();
    process.exit(1);
  }
}

run().catch((e) => { console.error('error:', e.message); process.exit(1); });
