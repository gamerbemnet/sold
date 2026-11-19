# Sold — Discord-style chat with real-time calling

*(formerly "Confide"; GitHub repo `sold`, hosted on Cloudflare Pages + Workers)*

A private, Discord-style chat: direct messages first, invite-only servers,
real-time text chat with typing indicators, and WebRTC voice/video rooms with
screen sharing. New accounts start with **no servers and no friends** — add
someone by username, they accept, and you can message each other. Everyone
else can see nothing.

## Features

**Friends & direct messages**
- Username-based friend requests: send → accept/decline → direct message
- Discord-style DM tab: home screen is your friends + DMs (DMs first, always)
- DM history persists (last 200 messages per conversation), unread badges,
  online presence, duplicate usernames auto-renamed
- Presence is shared: friends see when you're in a call and vice versa

**Private servers**
- Discord-style servers: own channel list, own member list, own invite code
- Create a server (5 seeded channels) or join one with an 8-character invite code
- Invite links (`https://<host>/?invite=CODE`) — sign in and you land straight
  in the server
- Everything is scoped server-side: history, messages, reactions, typing,
  member presence and voice rooms never cross a server boundary
- No-publics by design: fresh accounts see nothing until they create or are
  invited to a server
- Switch servers from the icon rail; leave with one click (owners can't orphan
  a server)

**Accounts**
- Sign up / sign in with username + password (PBKDF2-HMAC-SHA256 on the live
  backend — the local Node dev server still uses scrypt), per-account color
- Change-password button in the user panel; changing your password signs out
  your other sessions
- Session tokens (30 days); the backend requires a valid token for every
  privileged call — no more free-for-all names
- Light brute-force protection (30 auth attempts / 10 min / IP), logout button
  in the user panel

**Text chat**
- Text channels (`#general`, `#random`, `#help`) + create your own
- Real-time messages over SSE (server → client) + POST `/api/action`
  (client → server) on the live backend — full-duplex over HTTP/2
  (the local Node dev server still speaks Socket.IO)
- Message history (last 200/channel), typing indicators (animated dots),
  day dividers, message grouping, emoji picker
- Emoji reactions (👍 ❤️ 😂 🎉 🔥 😮) with live counts, toggle on/off, persisted
- Unread badges per channel (count + white rail indicator), auto-cleared on read
- In-channel message search/filter, "jump to latest" with a missed-message count
- Welcome hero at the top of each channel, hover timestamps on grouped messages
- User list with online status

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
chat, then click a voice channel to call. The local server is a development
backend: Express + Socket.IO, state in `data/`. The live deployment uses the
Cloudflare backend described below.

### Auth API

```bash
POST /api/signup  {username, password}  -> {token, user}
POST /api/login   {username, password}  -> {token, user}
POST /api/logout  {token}               -> {ok}
POST /api/account/password {token, currentPassword, newPassword} -> {ok}
```

Usernames: 3–24 chars (`letters, numbers, _ . -`). Passwords: 6–100 chars.
The token is stored client-side and sent with each action; invalid/expired
tokens get an error and the app returns to the sign-in screen.

> Use `https://` (or `localhost`) — browsers only allow camera/microphone
> access on secure origins.

## Hosted deployment — https://soldchats.pages.dev

The app runs entirely on Cloudflare's free tier. No origin device, no
tunnel, no always-on server:

```
Browser (https://soldchats.pages.dev)
  ├── static UI ...................... Cloudflare Pages (global edge)
  ├── /api/* ......................... Cloudflare Worker (sold-backend.<subdomain>.workers.dev)
  │     ├── accounts/sessions/servers/friends/DMs/history/presence  -> R2 bucket (project-sold-blob)
  │     ├── realtime: SSE GET /api/events (per-user outboxes, polled ~800ms)
  │     └── client -> server actions: POST /api/action
  └── WebRTC media ................... directly between peers (STUN) or via TURN relay
```

- **Pages** serves the static UI (HTML/CSS/JS) — no `_worker.js`, no proxy.
- **Worker** (`worker/src/`, plain Workers — no Durable Objects needed) keeps
  every piece of state in **R2** and is otherwise stateless: auth (PBKDF2 via
  WebCrypto), servers/channels, friends & DMs, message history, presence,
  TURN credentials cache, per-user realtime outboxes.
- **Realtime** is SSE (`/api/events?token=…&clientId=…&since=…`) for
  server → client delivery and `POST /api/action` for client → server
  actions; the client keeps presence fresh via a 25s heartbeat.
- WebRTC media never touches the Worker: peers connect directly (STUN) or
  through TURN.
- Deploy the UI:

```bash
CF_TOKEN=<pages api token> CF_ACCOUNT=<account id> CF_PROJECT=soldchats \
node scripts/deploy-pages.mjs
```

- Deploy the backend:

```bash
CF_TOKEN=<workers token> CF_ACCOUNT=<account id> \
node scripts/deploy-worker.mjs
```

The Pages token needs **Account · Cloudflare Pages · Edit**; the worker
token needs **Account · Workers Scripts · Edit** and **R2 · Edit**. The
pages script replicates `wrangler pages deploy` (BLAKE3 asset hashing →
upload → deployment); the worker script uploads the module directly via the
API with its R2 binding (`SOLD_DATA` → bucket `project-sold-blob`). Both
print what they do and need no npm dependencies.

- GitHub source: <https://github.com/gamerbemnet/sold>

### How calls work across networks

1. The client fetches `GET /api/turn` before joining a voice channel (and
   every 7 minutes) to get fresh STUN + TURN servers.
2. `/api/turn` proxies Cloudflare's public TURN credential endpoint
   (`speed.cloudflare.com/turn-creds`) — the upstream only answers requests
   carrying its own `Referer`, so browsers can't fetch it directly. Credentials
   are cached (in R2 on the Worker) and refreshed every 8 minutes.
3. Peers try direct (STUN) first; if the NATs won't cooperate, media flows
   through `turn.cloudflare.com` (UDP 3478 / TCP 3478 / TLS 5349) — a global
   relay, so any two peers anywhere can connect.

If `/api/turn` returns 503, calls still work for same-network / easy-NAT peers
(STUN-only); strict-NAT pairs will fail until the upstream is reachable again.

## Test

```bash
node test/protocol-test.mjs    # or: npm test — local Node backend
node test/pages-e2e.mjs        # live end-to-end against the deployed app + Worker
```

`test/protocol-test.mjs` (52 checks) spawns its **own** server in a
throwaway data directory, so it never touches your real accounts or
messages. Covers: signup/login (incl. duplicate username, wrong password,
tokenless-join rejection), fresh accounts starting serverless, server
creation with 5 seeded channels + invite code, joining via invite (and
rejection of bogus invites), message delivery & history, typing, emoji
reactions (add + toggle off), channel creation, voice join/peer discovery,
SDP & ICE relay, voice state broadcast, cross-server isolation probes (an
outsider account cannot open history, post, or join voice), leave/rejoin,
and disconnect handling.

`test/pages-e2e.mjs` (31 checks) exercises the live deployment over HTTP
and SSE: static serving, `/api/health`, CORS preflight, TURN credentials,
signup/login (incl. wrong password), server creation + invite join, SSE
transport (hello + bad-token rejection), bootstrap, message/typing/reaction
relay over SSE, voice join/peer discovery, SDP/ICE signaling relay, the
password endpoint (wrong current password rejected — no mutation), friend
request → accept (delivered live over SSE), DMs over SSE + `/api/history`,
and heartbeat. Note: it creates throwaway accounts (`alice-…`/`bob-…`) on
the live instance — prune them afterwards via `/api/admin/export` +
`/api/admin/import` if the instance is single-tenant.

TURN diagnostics (require network access):

```bash
node test/turn-cloudflare.cjs  # fetches fresh creds + verifies a real TURN allocation
node test/turn-test.cjs <host> <port> <user> <pass> [udp|tcp]  # generic TURN allocator check
```

## Layout

```
server.js              Express + Socket.IO dev/test backend (accounts, channels, history, signaling)
worker/src/            Live backend: stateless Cloudflare Worker, R2-backed
                       (const/state/password/domain/outbox/actions/sold/index)
worker/src/password.js WebCrypto PBKDF2 hashing (Free-plan-safe; scrypt blew the CPU limit)
public/index.html      UI structure (auth screen, server rail, sidebar, chat, voice panel, members)
public/style.css       Discord-like dark theme
public/app.js          Client: auth flow, chat rendering, WebRTC peers, media controls, ICE refresh;
                       talks to the Worker over SSE + fetch (API_BASE constant)
scripts/deploy-pages.mjs   Deploy the static UI to Cloudflare Pages
scripts/deploy-worker.mjs  Deploy the backend Worker (R2 binding) via the Cloudflare API
data/accounts.json     Local dev credentials + session tokens (created on first signup)
data/servers.json      Local dev servers, members, invites and channels
test/protocol-test.mjs End-to-end protocol test for the local backend (52 checks)
test/pages-e2e.mjs     Live end-to-end test: Pages (static) + Worker (SSE/POST), 31 checks
test/turn-cloudflare.cjs  Verifies Cloudflare TURN allocation end-to-end
```

The local `data/` directory and the local Node server are for development
and the protocol test only — the hosted service keeps its state in R2.
Set `SOLD_DATA_DIR` to relocate the local data directory.
