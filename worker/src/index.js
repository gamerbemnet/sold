/* Sold backend — Cloudflare Worker entry (stateless, R2-backed).
 *
 *   GET  /api/health   liveness probe (no storage access)
 *   GET  /api/events   SSE stream (presence registration + realtime delivery)
 *   *    /api/*        everything else (see sold.js)
 */
import { handleRequest, handleEvents } from './sold.js';
import { jsonRes, CORS_HEADERS } from './const.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return jsonRes({ ok: true, service: 'sold-backend' });
    }
    if (url.pathname === '/api/events') {
      if (request.method !== 'GET') return jsonRes({ error: 'method not allowed' }, 405);
      try { return await handleEvents(request, env); } catch (err) {
        console.warn('events error:', err && err.message);
        return jsonRes({ error: 'internal error' }, 500);
      }
    }
    if (url.pathname.startsWith('/api/')) return handleRequest(request, env, ctx);
    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
