# Sold — Discord-style chat with real-time calling

*(formerly "Confide"; GitHub repo `sold`, hosted on Cloudflare Pages)*

A browser-based Discord clone: server/channel sidebar, real-time text chat with
typing indicators, and WebRTC voice/video rooms with screen sharing.

## Features

**Accounts**
- Sign up / sign in with username + password (scrypt-hashed, per-account color)
- Session tokens (30 days) issued over `POST /api/signup` / `/api/login`;
  the Socket.IO `join` requires a valid token — no more free-for-all names
- Accounts & sessions persist to `data/accounts.json` (survive restarts)
- Light brute-force protection (30 auth attempts / 10 min / IP), logout button
  in the user panel

**Text chat**
- Text channels (`#general`, `#random`, `#help`) + create your own
- Real-time messages over Socket.IO, message history (last 200/channel)
- Typing indicators, day dividers, message grouping, emoji picker
- Unread badges per channel (count + white rail indicator), auto-cleared on read
- In-channel message search/filter, "jump to latest" with a missed-message count
- Welcome hero at the top of each channel, hover timestamps on grouped messages
- User list with online status, duplicate usernames auto-renamed

**Voice & video rooms**
- Join/leave voice channels (mesh WebRTC, works for small groups)
- Microphone mute, camera toggle, screen sharing (with "stopped sharing" recovery)
- Deafen, per-user mute badges, live connection state
- Grid of video tiles with camera-off avatars, mirroring for local preview
- Perfect-negotiation signaling (handles offer glare/collisions)
- Live "speaking" highlights (Web Audio levels → green ring on the tile and
  sidebar rows), maximize-call button, camera-off slash state
- STUN via Google & Cloudflare for direct peer-to-peer paths, plus **TURN relay**
  (Cloudflare's global TURN network) so calls work between peers on different
  networks, NATs and countries

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Open the URL in two browser windows, **create an account** (or sign in),
chat, then click a voice channel to call.

### Auth API

```bash
POST /api/signup  {username, password}  -> {token, user}
POST /api/login   {username, password}  -> {token, user}
POST /api/logout  {token}               -> {ok}
```

Usernames: 3–24 chars (`letters, numbers, _ . -`). Passwords: 6–100 chars.
The token is stored client-side and sent with the socket `join` event;
invalid/expired tokens get `join:error` and the app returns to the sign-in
screen.

> Use `https://` (or `localhost`) — browsers only allow camera/microphone
> access on secure origins.

## Run worldwide (public internet)

Anyone on any network can open the app over HTTPS:

```bash
# 1. start the app
node server.js

# 2. expose it with a free Cloudflare quick tunnel (HTTPS included)
cloudflared tunnel --url http://127.0.0.1:3000
```

The tunnel prints a `https://*.trycloudflare.com` URL — share that with anyone
in the world. Notes:

- **The URL is ephemeral**: it changes every time cloudflared restarts. For a
  stable address, use a named Cloudflare tunnel or a VM with a domain.
- HTTPS from the tunnel is what unlocks camera/microphone access on remote
  devices.

### How calls work across networks

1. The client fetches `GET /api/turn` before joining a voice channel (and
   every 7 minutes) to get fresh STUN + TURN servers.
2. `/api/turn` proxies Cloudflare's public TURN credential endpoint
   (`speed.cloudflare.com/turn-creds`) — the upstream only answers requests
   carrying its own `Referer`, so browsers can't fetch it directly. Credentials
   are cached server-side and refreshed every 8 minutes.
3. Peers try direct (STUN) first; if the NATs won't cooperate, media flows
   through `turn.cloudflare.com` (UDP 3478 / TCP 3478 / TLS 5349) — a global
   relay, so any two peers anywhere can connect.

If `/api/turn` returns 503, calls still work for same-network / easy-NAT peers
(STUN-only); strict-NAT pairs will fail until the upstream is reachable again.

## Hosted deployment — https://soldchats.pages.dev

The app is deployed on **Cloudflare Pages** behind a stable URL:

- **Static UI** (HTML/CSS/JS) is served directly from Pages' global edge.
- **`pages-build/_worker.js`** (Pages advanced-mode Worker) proxies `/api/*`
  and `/socket.io/*` — including WebSocket upgrades — to the origin server, so
  auth, chat, typing and voice signaling run in real time through `pages.dev`.
- The origin URL lives in the Pages environment variable **`ORIGIN`**, so when
  the cloudflared tunnel restarts with a new address you only update the
  variable and redeploy — no code changes:

```bash
CF_TOKEN=<pages api token> \
CF_ACCOUNT=<account id> \
ORIGIN=https://<current-tunnel-url> \
node scripts/deploy-pages.mjs
```

The token needs **Account · Cloudflare Pages · Edit**. The script replicates
what `wrangler pages deploy` does (BLAKE3 asset hashing → upload → deployment)
without requiring npm, and it verifies the `ORIGIN` env var before deploying —
Pages binds environment variables **at deploy time**, so the redeploy in the
same run is what makes the new origin take effect.

- Media (WebRTC) never touches Pages: peers connect directly or through TURN,
  so call quality doesn't depend on the origin server.
- GitHub source: <https://github.com/gamerbemnet/sold>

## Test

```bash
node test/protocol-test.mjs    # or: npm test
node test/pages-e2e.mjs        # end-to-end test of the deployed Pages site
```

23-check end-to-end test over raw Socket.IO/WebSocket, including auth
(signup, duplicate username, wrong password, login, tokenless-join rejection).

Covers: signup/login/logout (incl. duplicate username, wrong password, and
tokenless-join rejection), connect, join/init, message delivery & history,
typing, channel creation, voice join/peer discovery, SDP & ICE relay, voice
state broadcast, leave and disconnect handling.

`test/pages-e2e.mjs` re-runs the critical path through the public URL (14
checks): static serving, worker proxy (auth API + TURN credentials),
WebSocket transport through Pages, message/typing relay and WebRTC signaling
relay — proving the hosted deployment end to end.

TURN diagnostics (require network access):

```bash
node test/turn-cloudflare.cjs  # fetches fresh creds + verifies a real TURN allocation
node test/turn-test.cjs <host> <port> <user> <pass> [udp|tcp]  # generic TURN allocator check
```

## Layout

```
server.js          Express + Socket.IO server: accounts & sessions, channels,
                   history, voice signaling, /api/turn credential proxy
public/index.html  UI structure (auth screen, server rail, sidebar, chat, voice panel, members)
public/style.css   Discord-like dark theme
public/app.js      Client: auth flow, chat rendering, WebRTC peers, media controls, ICE refresh
pages-build/_worker.js  Pages advanced-mode worker: proxies /api + /socket.io to the ORIGIN env var
scripts/deploy-pages.mjs  Deploy to Cloudflare Pages (hash + upload + ORIGIN env + deployment)
data/accounts.json Persisted credentials + session tokens (created on first signup)
test/protocol-test.mjs  End-to-end protocol test (no extra deps)
test/pages-e2e.mjs  End-to-end test of the deployed Pages site (HTTP + WebSocket)
test/turn-cloudflare.cjs  Verifies Cloudflare TURN allocation end-to-end
```

Channels, messages and voice state are in-memory: restarting the server
resets them. Accounts and sessions are persisted to `data/accounts.json`.
