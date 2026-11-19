#!/usr/bin/env node
/**
 * Deploy the Sold backend to Cloudflare Workers (stateless, R2-backed).
 *
 * Raw Cloudflare API + fetch + FormData — no wrangler, no npm installs:
 *   1. PUT /accounts/:acct/workers/scripts/sold-backend  (module upload,
 *      R2 bucket binding "SOLD_DATA" -> bucket "project-sold-blob")
 *   2. read (or create) the account's workers.dev subdomain
 *   3. enable the script on the subdomain route
 *   4. PUT an ADMIN_SECRET secret for the /api/admin/* endpoints
 *   5. health-check https://sold-backend.<sub>.workers.dev/api/health
 *
 * Usage:
 *   CF_TOKEN=<api token> CF_ACCOUNT=<account id> node scripts/deploy-worker.mjs
 *
 * The token is only read from the environment; it is never written to disk.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const CF_TOKEN = process.env.CF_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT;
const SCRIPT_NAME = 'sold-backend';
const R2_BUCKET = 'project-sold-blob';
const COMPATIBILITY_DATE = '2025-09-01';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'worker', 'src');

function fail(msg, detail) {
  console.error(`FAIL  ${msg}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function api(url, { token = CF_TOKEN, raw = false, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!raw && (!res.ok || (json && json.success === false))) {
    fail(`API ${init.method || 'GET'} ${url} -> ${res.status}`, json || text.slice(0, 800));
  }
  return { res, json, text };
}

function collectModules() {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.js')) out.push({ name: r, content: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC, '');
  return out;
}

async function main() {
  if (!CF_TOKEN) fail('CF_TOKEN is not set');
  if (!CF_ACCOUNT) fail('CF_ACCOUNT is not set');

  const modules = collectModules();
  console.log(`modules: ${modules.map((m) => m.name).join(', ')}`);
  if (!modules.some((m) => m.name === 'index.js')) fail('missing index.js');

  /* ---- 1. upload the script ---- */
  const metadata = {
    main_module: 'index.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { name: 'SOLD_DATA', type: 'r2_bucket', bucket_name: R2_BUCKET },
    ],
  };
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  for (const m of modules) {
    form.set(m.name, new Blob([m.content], { type: 'application/javascript+module' }), m.name);
  }
  await api(`${API}/accounts/${CF_ACCOUNT}/workers/scripts/${SCRIPT_NAME}`, {
    method: 'PUT', body: form,
  });
  console.log('script uploaded');

  /* ---- 2. find (or create) the workers.dev subdomain ---- */
  let subdomain = null;
  {
    const { res, json } = await api(`${API}/accounts/${CF_ACCOUNT}/workers/subdomain`, { raw: true });
    if (res.ok && json && json.result && json.result.subdomain) {
      subdomain = json.result.subdomain;
    }
  }
  if (!subdomain) {
    for (const candidate of ['soldbackend', 'gamerbemnet', 'soldchats']) {
      const { res, json } = await api(`${API}/accounts/${CF_ACCOUNT}/workers/subdomain`, {
        method: 'PUT', raw: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: candidate }),
      });
      if (res.ok && json && json.result && json.result.subdomain) {
        subdomain = json.result.subdomain;
        break;
      }
      console.warn(`subdomain "${candidate}" not available, trying next…`);
    }
  }
  if (!subdomain) {
    fail('could not obtain a workers.dev subdomain — create one in the dashboard (Workers & Pages → your account → workers.dev subdomain), then re-run');
  }
  console.log(`workers.dev subdomain: ${subdomain}`);

  /* ---- 3. enable the script on the subdomain ---- */
  await api(`${API}/accounts/${CF_ACCOUNT}/workers/scripts/${SCRIPT_NAME}/subdomain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  console.log('route enabled on workers.dev');

  /* ---- 4. set the ADMIN_SECRET secret (fresh random; printed once) ---- */
  const adminSecret = randomBytes(24).toString('hex');
  {
    const { res } = await api(`${API}/accounts/${CF_ACCOUNT}/workers/scripts/${SCRIPT_NAME}/secrets`, {
      method: 'PUT', raw: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'secret_text', name: 'ADMIN_SECRET', text: adminSecret }),
    });
    if (!res.ok) {
      await api(`${API}/accounts/${CF_ACCOUNT}/workers/scripts/${SCRIPT_NAME}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'secret_text', name: 'ADMIN_SECRET', text: adminSecret }),
      });
    }
  }
  console.log(`ADMIN_SECRET set: ${adminSecret}`);

  /* ---- 5. health check ---- */
  const base = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
      const body = await res.text();
      ok = res.ok && body.includes('sold-backend');
      if (!ok) console.warn(`health check attempt ${i + 1}: ${res.status} ${body.slice(0, 120)}`);
    } catch (err) {
      console.warn(`health check attempt ${i + 1}: ${err.message}`);
    }
  }
  if (!ok) fail(`worker did not become healthy at ${base}`);
  console.log(`DEPLOY OK  ${base}`);
}

main().catch((err) => fail(err.message, err.stack));
