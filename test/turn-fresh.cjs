/* Fetch FRESH credentials from Cloudflare's public speed-test endpoint, then
 * try authenticated Allocate variants with a fresh nonce each time. */
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const txid = () => { const b = Buffer.alloc(12); for (let i = 0; i < 12; i++) b[i] = (Math.random() * 256) | 0; return b; };
const attr = (t, v) => { const pad = (4 - (v.length % 4)) % 4; const b = Buffer.alloc(4 + v.length + pad); b.writeUInt16BE(t, 0); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; };
const build = (type, attrs, id) => { const body = Buffer.concat(attrs); const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(body.length, 2); h.writeUInt32BE(MAGIC, 4); id.copy(h, 8); return Buffer.concat([h, body]); };

function errStr(m) {
  let off = 20, out = '';
  while (off + 4 <= m.length) {
    const t = m.readUInt16BE(off), l = m.readUInt16BE(off + 2), v = m.slice(off + 4, off + 4 + l);
    if (t === 0x0009) out += ` error=${v[2] * 100 + v[3]}`;
    if (t === 0x0015) out += ' nonce=fresh';
    if (t === 0x0020) {
      const port = v.readUInt16BE(0) ^ 0x2112;
      const ip = [...v.slice(4, 8)].map((n, i) => n ^ [0x21, 0x12, 0xa4, 0x42][i]).join('.');
      out += ` RELAY=${ip}:${port}`;
    }
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return out || ' no-error-attrs';
}

function crc32(buf) {
  let table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const sock = dgram.createSocket('udp4');
const ask = (msg) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 5000);
  sock.once('message', (m) => { clearTimeout(t); res(m); });
  sock.send(msg, 3478, 'turn.cloudflare.com');
});

function getNonce(msg) {
  let off = 20;
  while (off + 4 <= msg.length) {
    const t = msg.readUInt16BE(off), l = msg.readUInt16BE(off + 2);
    if (t === 0x0015) return msg.slice(off + 4, off + 4 + l);
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return null;
}

(async () => {
  const res = await fetch('https://speed.cloudflare.com/turn-creds', {
    headers: { Referer: 'https://speed.cloudflare.com/', Origin: 'https://speed.cloudflare.com' },
  });
  const cfg = await res.json();
  if (!cfg.username) { console.log('no creds:', JSON.stringify(cfg)); process.exit(1); }
  const { username: user, credential: cred } = cfg;
  console.log('fresh creds fetched, user len', user.length);

  const attempt = async (label, opts) => {
    const id1 = txid();
    const r1 = await ask(build(0x0003, [attr(0x000d, Buffer.from([17, 0, 0, 0]))], id1));
    const nonce = getNonce(r1);
    if (!nonce) { console.log(label, '-> no nonce on unauth:', errStr(r1)); return; }

    const base = build(0x0003, [
      attr(0x0006, Buffer.from(user)),
      attr(0x0014, Buffer.from(cfg.urls ? 'turn.cloudflare.com' : 'turn.cloudflare.com')),
      attr(0x0015, Buffer.from(nonce)),
      attr(0x000d, Buffer.from([17, 0, 0, 0])),
    ], txid());

    const wl = Buffer.from(base);
    let out;
    if (opts.algo === 'sha1') wl.writeUInt16BE(wl.length - 20 + 24, 2);
    else wl.writeUInt16BE(wl.length - 20 + 32, 2);

    let key;
    if (opts.key === 'md5') key = crypto.createHash('md5').update(`${user}:turn.cloudflare.com:${cred}`).digest();
    else if (opts.key === 'pass') key = Buffer.from(cred);
    else key = Buffer.from(cred, 'hex');

    const mac = opts.algo === 'sha1'
      ? crypto.createHmac('sha1', key).update(wl).digest()
      : crypto.createHmac('sha256', key).update(wl).digest();

    out = Buffer.concat([wl, attr(opts.algo === 'sha1' ? 0x0008 : 0x001e, mac)]);
    if (opts.fp) {
      const wl2 = Buffer.from(out);
      wl2.writeUInt16BE(wl2.length - 20 + 8, 2);
      const fp = Buffer.alloc(4);
      fp.writeUInt32BE((crc32(wl2) ^ 0x5354554e) >>> 0, 0);
      out = Buffer.concat([wl2, attr(0x8028, fp)]);
    }

    const r2 = await ask(out);
    const ok = r2.readUInt16BE(0) === 0x0003;
    console.log(`${label.padEnd(34)} ->${ok ? ' SUCCESS ✅' : ''} ${errStr(r2)}`);
    return ok;
  };

  const combos = [];
  for (const algo of ['sha1', 'sha256'])
    for (const key of ['md5', 'pass', 'hex'])
      for (const fp of [true, false])
        combos.push([`${algo} key=${key} fp=${fp}`, { algo, key, fp }]);

  for (const [label, opts] of combos) {
    try { if (await attempt(label, opts)) process.exit(0); } catch (e) { console.log(label, 'ERR', e.message); }
  }
  console.log('no variant succeeded');
  process.exit(1);
})();
