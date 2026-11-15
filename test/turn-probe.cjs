/* Reuse the STUN binding probe against TURN candidates. */
const net = require('net');
const dgram = require('dgram');

const TARGETS = [
  ['freestun.net', 3478],
  ['freestun.net', 443],
  ['turn.speed.cloudflare.com', 50000],
  ['turn.speed.cloudflare.com', 443],
  ['relay.metered.ca', 3478],
  ['relay.metered.ca', 80],
  ['relay.metered.ca', 443],
  ['stun.nextcloud.com', 3478],
];

function req() {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(1, 0); b.writeUInt16BE(0, 2); b.writeUInt32BE(0x2112a442, 4);
  for (let i = 0; i < 12; i++) b.writeUInt8((Math.random() * 256) | 0, 8 + i);
  return b;
}
const alive = (m) => m.length >= 20 && (m.readUInt16BE(0) === 0x0101 || m.readUInt16BE(0) === 0x0111);

function udp(host, port) {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { s.close(); } catch (_) {} res('timeout'); }, 5000);
    s.on('message', (m) => { clearTimeout(t); s.close(); res(alive(m) ? 'ALIVE' : 'reply'); });
    s.on('error', (e) => { clearTimeout(t); res('err:' + e.code); });
    s.send(req(), port, host);
  });
}
function tcp(host, port) {
  return new Promise((res) => {
    const t = setTimeout(() => res('timeout'), 5000);
    const s = net.connect({ host, port }, () => {
      s.write(req());
      s.once('data', (m) => { clearTimeout(t); s.destroy(); res(alive(m) ? 'ALIVE(tcp-stun)' : 'connected'); });
      setTimeout(() => { if (!s.destroyed) { clearTimeout(t); s.destroy(); res('connected'); } }, 4500);
    });
    s.on('error', (e) => { clearTimeout(t); res('err:' + e.code); });
  });
}

(async () => {
  for (const [h, p] of TARGETS) {
    const [u, t] = await Promise.all([udp(h, p), tcp(h, p)]);
    console.log(`${h}:${p}  udp=${u}  tcp=${t}`);
  }
  process.exit(0);
})();
