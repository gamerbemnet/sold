/* Sold backend — shared constants and tiny utilities (ES module). */

export const LOWER = (v) => String(v || '').toLowerCase();
export const MAX_HISTORY = 200;      // messages kept per thread/channel
export const MAX_OUTBOX = 200;       // pending realtime events kept per user
export const PRESENCE_TTL_MS = 90 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const PBKDF2_ITERATIONS = 100000;

export const TURN_UPSTREAM = 'https://speed.cloudflare.com/turn-creds';
export const TURN_UPSTREAM_HEADERS = {
  Referer: 'https://speed.cloudflare.com/',
  Origin: 'https://speed.cloudflare.com',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};
export const TURN_REFRESH_MS = 8 * 60 * 1000;

export const DEFAULT_CHANNEL_SEED = [
  { name: 'general', type: 'text', topic: 'Talk about anything' },
  { name: 'random', type: 'text', topic: 'Memes, links and off-topic' },
  { name: 'help', type: 'text', topic: 'Ask for help here' },
  { name: 'Lobby', type: 'voice', topic: 'Hang out and chat' },
  { name: 'Gaming', type: 'voice', topic: 'Squad up' },
];
export const SERVER_COLORS = ['#ff7a59', '#c084fc', '#3ba55c', '#faa61a', '#eb459e', '#1abc9c', '#9b59b6', '#00bcd4'];
export const MAX_SERVERS_PER_USER = 12;
export const MAX_CHANNELS_PER_SERVER = 60;
export const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63', '#00bcd4'];
export const USERNAME_RE = /^[a-z0-9_][a-z0-9_.-]{2,23}$/i;
export const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '🎉', '😮', '🔥']);
export const CLIENT_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export const normalizeUsername = (v) => String(v || '').trim().slice(0, 24);

const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
export { toHex };
export const randHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
export const randInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
export const timingSafeEqualStr = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
export const newMessageId = () => Date.now() * 1000 + randInt(1000);

/* media (avatars/banners): stored as raw bytes in R2 under media/* */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 4 MB per image
export const avatarKey = (username) => `media/avatar/${LOWER(username)}`;
export const bannerKey = (username) => `media/banner/${LOWER(username)}`;
export const serverBannerKey = (serverId) => `media/server-banner/${serverId}`;

/* magic-byte sniff — never trust the client-declared content type */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
export const jsonRes = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
