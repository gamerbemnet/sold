/* Single clean verification of Cloudflare's public TURN credentials:
 * fetch fresh creds, allocate a relay, print the relayed address. */
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const txid = () => { const b = Buffer.alloc(12); for (let i = 0; i < 12; i++) b[i] = (Math.random() * 256) | 0; return b; };
const attr = (t, v) => { const pad = (4 - (v.length % 4)) % 4; const b = Buffer.alloc(4 + v.length + pad); b.writeUInt16BE(t, 0); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; };
const build = (type, attrs, id) => { const body = Buffer.concat(attrs); const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(body.length, 2); h.writeUInt32BE(MAGIC, 4); id.copy(h, 8); return Buffer.concat([h, body]); };

function attrs(m) {
  const out = {}; let off = 20;
  while (off + 4 <= m.length) {
    const t = m.readUInt16BE(off), l = m.readUInt16BE(off + 2);
    out[t] = m.slice(off + 4, off + 4 + l);
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return out;
}
const errText = (a) => a[0x0009] ? `${a[0x0009][2] * 100 + a[0x0009][3]} "${a[0x0009].slice(4).toString()}"` : 'none';
const xorPort = (v) => v.readUInt16BE(0) ^ (MAGIC >>> 16);
const xorIp = (v) => [...v.slice(4, 8)].map((n, i) => n ^ [(MAGIC >>> 24) & 255, (MAGIC >>> 16) & 255, (MAGIC >>> 8) & 255, MAGIC & 255][i]).join('.');

(async () => {
  const res = await fetch('https://speed.cloudflare.com/turn-creds', {
    headers: { Referer: 'https://speed.cloudflare.com/', Origin: 'https://speed.cloudflare.com', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  const cfg = await res.json();
  if (!cfg.username) { console.log('creds fetch failed:', JSON.stringify(cfg)); process.exit(1); }

  const turnUrl = (cfg.urls || []).find((u) => u.startsWith('turn:') && u.includes('transport=udp')) || 'turn:turn.cloudflare.com:3478?transport=udp';
  const host = turnUrl.replace(/^turn:/, '').split('?')[0];
  const [hostname, port] = host.split(':');
  const portNum = Number(port) || 3478;
  console.log('using', hostname + ':' + portNum);

  const sock = dgram.createSocket('udp4');
  const ask = (msg) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 6000);
    sock.once('message', (m) => { clearTimeout(t); resolve(m); });
    sock.send(msg, portNum, hostname);
  });

  const id1 = txid();
  const r1 = await ask(build(0x0003, [attr(0x0019, Buffer.from([17, 0, 0, 0]))], id1));
  const a1 = attrs(r1);
  console.log('unauthenticated ->', r1.readUInt16BE(0) === 0x0113 ? 'auth required (' + errText(a1) + ')' : 'type 0x' + r1.readUInt16BE(0).toString(16));
  if (!a1[0x0015]) { console.log('no nonce — aborting'); process.exit(1); }

  const realm = a1[0x0014] ? a1[0x0014].toString() : 'turn.cloudflare.com';
  const id2 = txid();
  const base = build(0x0003, [
    attr(0x0006, Buffer.from(cfg.username)),
    attr(0x0014, Buffer.from(realm)),
    attr(0x0015, Buffer.from(a1[0x0015].toString())),
    attr(0x0019, Buffer.from([17, 0, 0, 0])),
  ], id2);
  const key = crypto.createHash('md5').update(`${cfg.username}:${realm}:${cfg.credential}`).digest();
  const wl = Buffer.from(base);
  wl.writeUInt16BE(wl.length - 20 + 24, 2);
  const auth = Buffer.concat([wl, attr(0x0008, crypto.createHmac('sha1', key).update(wl).digest())]);

  const r2 = await ask(auth);
  const a2 = attrs(r2);
  const type = r2.readUInt16BE(0);
  if (type === 0x0103) {
    const relay = a2[0x0016];
    console.log('TURN ALLOCATION SUCCESS ✅  relay=' + (relay ? xorIp(relay) + ':' + xorPort(relay) : '?'));
    console.log('lifetime=' + (a2[0x000d] ? a2[0x000d].readUInt32BE(0) : '?') + 's');
    sock.close();
    process.exit(0);
  }
  console.log('FAILED → type=0x' + type.toString(16), 'error=' + errText(a2));
  sock.close();
  process.exit(1);
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
