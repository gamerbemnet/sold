/* Per-user realtime outboxes in R2.
 *
 * Free Workers cannot push events across isolates, so each client opens an
 * SSE stream that polls its own outbox (default ~800ms) and streams whatever
 * new items appear. Actions flush their effects here before responding.
 *
 * Shape: outbox/<username> -> { next: <int>, items: [{ seq, event, body }] }
 */
import { MAX_OUTBOX, LOWER } from './const.js';
import { r2Get, r2Put } from './state.js';

const keyFor = (username) => `outbox/${LOWER(username)}`;

/* Append all effects to their target users' outboxes. */
export async function flushEffects(env, effects) {
  if (!effects.length) return;
  const byUser = new Map();
  for (const e of effects) {
    if (!byUser.has(e.to)) byUser.set(e.to, []);
    byUser.get(e.to).push(e);
  }
  await Promise.all([...byUser].map(async ([username, list]) => {
    const key = keyFor(username);
    const box = (await r2Get(env, key)) || { next: 1, items: [] };
    let next = Number.isInteger(box.next) ? box.next : 1;
    const items = Array.isArray(box.items) ? box.items.slice() : [];
    for (const e of list) items.push({ seq: next++, event: e.event, body: e.body });
    while (items.length > MAX_OUTBOX) items.shift();
    await r2Put(env, key, { next, items });
  }));
}

/* Current outbox cursor for a user (used by /api/bootstrap and as the SSE
 * resume position). */
export async function outboxCursor(env, username) {
  const box = await r2Get(env, keyFor(username));
  return box && Number.isInteger(box.next) ? box.next : 1;
}

/* Read items with seq >= cursor. Returns { items, nextCursor }. */
export async function outboxRead(env, username, cursor) {
  const box = await r2Get(env, keyFor(username));
  if (!box || !Array.isArray(box.items)) return { items: [], cursor };
  const items = box.items.filter((item) => item.seq >= cursor);
  const nextCursor = items.length ? items[items.length - 1].seq + 1 : cursor;
  return { items, cursor: nextCursor };
}
