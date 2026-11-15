/* Probe public STUN/TURN servers: DNS + STUN binding over UDP and TCP. */
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;

const TARGETS = [
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
  ['openrelay.metered.ca', 80],
  ['openrelay.metered.ca', 3478],
  ['turn.anyfirewall.com', 443],
  ['turn.anyfirewall.com', 3478],
  ['webrtc.stunprotocol.org', 3478],
  ['stun.nextcloud.com', 3478],
  ['stun.miwifi.com', 3478],
  ['stun.doubao.com', 3478],
  ['stun.syncthing.net', 3478],
];

function bindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);      // Binding request
  buf.writeUInt16BE(0, 2);           // length
  buf.writeUInt32BE(0x2112a442, 4);  // magic cookie
  for (let i = 0; i < 12; i++) buf.writeUInt8(Math.floor(Math.random() * 256), 8 + i);
  return buf;
}

function isStunResponse(buf) {
  if (buf.length < 20) return false;
  const type = buf.readUInt16BE(0);
  return type === 0x0101 || type === 0x0111; // success / error (means server alive)
}

function probeUdp(host, port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { s.close(); } catch (_) {} resolve('timeout'); }, 4000);
    s.on('message', (msg) => { clearTimeout(t); s.close(); resolve(isStunResponse(msg) ? 'ALIVE' : 'reply?'); });
    s.on('error', (e) => { clearTimeout(t); try { s.close(); } catch (_) {} resolve('err:' + e.code); });
    s.send(bindingRequest(), port, host);
  });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 4000);
    const sock = net.connect({ host, port }, () => {
      sock.write(bindingRequest());
      const onData = (msg) => {
        clearTimeout(t);
        try { sock.destroy(); } catch (_) {}
        resolve(isStunResponse(msg) ? 'ALIVE' : 'connected');
      };
      sock.once('data', onData);
      setTimeout(() => { if (!sock.destroyed) { clearTimeout(t); sock.destroy(); resolve('connected'); } }, 3500);
    });
    sock.on('error', (e) => { clearTimeout(t); resolve('err:' + e.code); });
    sock.on('timeout', () => { clearTimeout(t); try { sock.destroy(); } catch (_) {} resolve('timeout'); });
  });
}

(async () => {
  for (const [host, port] of TARGETS) {
    let ip = '';
    try {
      const r = await dns.lookup(host);
      ip = r.address;
      if (/^(100::|0\.0\.0\.0|127\.)/.test(ip)) { console.log(`${host}:${port}  DNS=${ip} (sinkhole)  SKIP`); continue; }
    } catch (e) { console.log(`${host}:${port}  DNS FAIL ${e.code}`); continue; }

    const [udp, tcp] = await Promise.all([probeUdp(host, port), probeTcp(host, port)]);
    console.log(`${host}:${port}  ip=${ip}  udp=${udp}  tcp=${tcp}`);
  }
  process.exit(0);
})();
