/* soldchats.pages.dev — Cloudflare Pages advanced-mode Worker.
 *
 * The Node/Socket.IO server cannot run on Pages, so this Worker splits traffic:
 *   - /api/* and /socket.io/*  → proxied to the live origin (cloudflared tunnel),
 *     configured in the ORIGIN Pages environment variable
 *   - everything else          → static UI assets bundled with this deployment,
 *     with the origin as fallback
 *
 * WebSocket upgrades (Socket.IO transport) are passed through transparently.
 */

const PROXIED = (p) => p.startsWith('/api/') || p.startsWith('/socket.io');

const originUrl = (env, url) => {
  const base = (env.ORIGIN || '').replace(/\/+$/, '');
  return base + url.pathname + url.search;
};

async function proxy(request, target) {
  const init = {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
  };
  // Buffer non-GET bodies (Socket.IO polling POSTs, auth JSON) — avoids
  // ReadableStream-body/duplex quirks and they're all small.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }
  return fetch(target, init);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (PROXIED(url.pathname)) {
      if (!env.ORIGIN) return new Response('origin not configured', { status: 503 });
      try {
        return await proxy(request, originUrl(env, url));
      } catch (err) {
        return new Response('origin unreachable: ' + err.message, { status: 502 });
      }
    }

    // Static assets shipped with this deployment…
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      try {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
      } catch (_) {
        /* fall through to origin */
      }
    }

    // …then anything else (favicon etc.) via the origin…
    if (env.ORIGIN) {
      try {
        return await proxy(request, originUrl(env, url));
      } catch (_) {
        /* fall through */
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
