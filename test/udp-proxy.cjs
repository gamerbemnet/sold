/* Intercepting UDP proxy: logs hex of client->server packets, forwards both ways. */
const dgram = require('dgram');
const fs = require('fs');

const LISTEN = 3478, TARGET = 3479;
const log = [];
const sock = dgram.createSocket('udp4');
const remote = dgram.createSocket('udp4');
let clientKey = null;

sock.on('message', (msg, rinfo) => {
  clientKey = `${rinfo.address}:${rinfo.port}`;
  log.push(`C->S (${msg.length}b) ${msg.toString('hex')}`);
  remote.send(msg, TARGET, '127.0.0.1');
});
remote.on('message', (msg) => {
  log.push(`S->C (${msg.length}b) ${msg.toString('hex').slice(0, 80)}...`);
  if (clientKey) {
    const [addr, port] = clientKey.split(':');
    sock.send(msg, Number(port), addr);
  }
});

sock.bind(LISTEN, '127.0.0.1', () => {
  console.log(`proxy 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET}`);
  fs.writeFileSync('/tmp/proxy.pid', String(process.pid));
  fs.writeFileSync('/tmp/proxy-log.txt', '');
});

setInterval(() => {
  if (log.length) fs.writeFileSync('/tmp/proxy-log.txt', log.join('\n'));
}, 500);
process.on('SIGTERM', () => { fs.writeFileSync('/tmp/proxy-log.txt', log.join('\n')); process.exit(0); });
