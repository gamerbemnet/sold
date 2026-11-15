/* Brute-force structural variants of an authenticated TURN Allocate against
 * turn.cloudflare.com to find what it accepts. */
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const user = 'g08168dc230013c807da3560d69a561869ed3b30d9f128d557a9bb2a45d0e9f3';
const cred = 'd9dbbc4da994984d08036035d1136c740c2144aca306ce5f34ef06727c9d58d6';
const realm = 'turn.cloudflare.com';

const txid = () => { const b = Buffer.alloc(12); for (let i = 0; i < 12; i++) b[i] = (Math.random() * 256) | 0; return b; };
const attr = (t, v) => { const pad = (4 - (v.length % 4)) % 4; const b = Buffer.alloc(4 + v.length + pad); b.writeUInt16BE(t, 0); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; };
const build = (type, attrs, id) => { const body = Buffer.concat(attrs); const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(body.length, 2); h.writeUInt32BE(MAGIC, 4); id.copy(h, 8); return Buffer.concat([h, body]); };

function errStr(m) {
  let off = 20;
  while (off + 4 <= m.length) {
    const t = m.readUInt16BE(off), l = m.readUInt16BE(off + 2), v = m.slice(off + 4, off + 4 + l);
    if (t === 0x0009) return String(v[2] * 100 + v[3]);
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return 'no-error type=0x' + m.readUInt16BE(0).toString(16);
}

const sock = dgram.createSocket('udp4');
const ask = (msg) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 5000);
  sock.once('message', (m) => { clearTimeout(t); res(m); });
  sock.send(msg, 3478, 'turn.cloudflare.com');
});

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function withMi(baseMsg, mode) {
  const wl = Buffer.from(baseMsg);
  if (mode === 'sha1-adj' || mode === 'fp' || mode === 'adj-noRT') wl.writeUInt16BE(wl.length - 20 + 24, 2);
  const key = crypto.createHash('md5').update(`${user}:${realm}:${cred}`).digest();
  let mac;
  if (mode === 'unadj') mac = crypto.createHmac('sha1', key).update(wl).digest();          // length NOT adjusted
  else mac = crypto.createHmac('sha1', key).update(wl).digest();
  let out = Buffer.concat([wl, attr(0x0008, mac)]);
  if (mode === 'fp') {
    const wl2 = Buffer.from(out);
    wl2.writeUInt16BE(wl2.length - 20 + 8, 2);
    const fp = Buffer.alloc(4); fp.writeUInt32BE((crc32(wl2) ^ 0x5354554e) >>> 0, 0);
    out = Buffer.concat([wl2, attr(0x8028, fp)]);
  }
  return out;
}

(async () => {
  const id1 = txid();
  const r1 = await ask(build(0x0003, [attr(0x000d, Buffer.from([17, 0, 0, 0]))], id1));
  let off = 20, nonce = null;
  while (off + 4 <= r1.length) { const t = r1.readUInt16BE(off), l = r1.readUInt16BE(off + 2); if (t === 0x0015) nonce = r1.slice(off + 4, off + 4 + l); off += 4 + Math.ceil(l / 4) * 4; }
  console.log('unauth ->', errStr(r1));

  const variants = {
    'A baseline order': () => build(0x0003, [attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, Buffer.from(nonce)), attr(0x000d, Buffer.from([17, 0, 0, 0]))], txid()),
    'B transport first': () => build(0x0003, [attr(0x000d, Buffer.from([17, 0, 0, 0])), attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, Buffer.from(nonce))], txid()),
    'C +SOFTWARE': () => build(0x0003, [attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, Buffer.from(nonce)), attr(0x000d, Buffer.from([17, 0, 0, 0])), attr(0x8022, Buffer.from('test'))], txid()),
    'D +LIFETIME': () => build(0x0003, [attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, Buffer.from(nonce)), attr(0x000d, Buffer.from([17, 0, 0, 0])), attr(0x000d, Buffer.from([0, 0, 0, 0])), attr(0x000f, Buffer.from([0, 0, 14, 0x10]))], txid()),
  };
  const modes = ['sha1-adj', 'unadj', 'fp'];

  for (const [label, mk] of Object.entries(variants)) {
    for (const mode of modes) {
      try {
        const r = await ask(withMi(mk(), mode));
        const e = errStr(r);
        const ok = r.readUInt16BE(0) === 0x0003;
        console.log(`${label} | ${mode} -> ${e} ${ok ? 'SUCCESS ✅' : ''}`);
        if (ok) process.exit(0);
      } catch (err) { console.log(`${label} | ${mode} -> ERR ${err.message}`); }
    }
  }
  process.exit(1);
})();
