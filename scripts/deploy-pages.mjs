#!/usr/bin/env node
/**
 * Deploy the Sold UI to Cloudflare Pages (static-only).
 *
 * Replicates what `wrangler pages deploy` does against the Pages API, without
 * needing wrangler/npm:
 *   1. fetch an upload-token JWT for the project
 *   2. hash each asset with wrangler's hashFile: BLAKE3(base64(content) + ext)[0:32]
 *   3. /pages/assets/check-missing -> upload -> upsert-hashes
 *   4. POST the deployment (manifest + branch)
 *
 * No _worker.js is deployed: the client talks directly to the Cloudflare
 * Worker backend (sold-backend.<subdomain>.workers.dev) with CORS enabled,
 * so Pages only serves static assets. The old ORIGIN proxy env var is no
 * longer used (a best-effort attempt to clear it is made, never fatal).
 *
 * Usage:
 *   CF_TOKEN=<pages api token> \
 *   CF_ACCOUNT=<account id> \
 *   CF_PROJECT=soldchats \
 *   node scripts/deploy-pages.mjs
 *
 * The token is only read from the environment; it is never written to disk.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// blake3-wasm (installed under /tmp by the setup script — same algorithm
// wrangler uses for Pages asset hashes)
const b3 = require(process.env.BLAKE3_PATH || '/tmp/b3/package');

const API = 'https://api.cloudflare.com/client/v4';
const CF_TOKEN = process.env.CF_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT;
const CF_PROJECT = process.env.CF_PROJECT || 'soldchats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'public');          // the live UI source
const BRANCH = 'main';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function fail(msg, detail) {
  console.error(`FAIL  ${msg}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function api(url, { token = CF_TOKEN, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || (json && json.success === false)) {
    fail(`API ${init.method || 'GET'} ${url} -> ${res.status}`, json || text.slice(0, 800));
  }
  return json;
}

async function main() {
  if (!CF_TOKEN) fail('CF_TOKEN is not set');
  if (!CF_ACCOUNT) fail('CF_ACCOUNT is not set');

  await b3.load();

  /* ---- 1. hash the assets (wrangler's hashFile algorithm) ---- */
  const assetNames = ['index.html', 'style.css', 'app.js', 'favicon.ico'].filter((n) =>
    // only ship what exists
    (() => { try { readFileSync(path.join(ASSET_DIR, n)); return true; } catch { return false; } })()
  );
  if (!assetNames.includes('index.html')) fail(`no index.html in ${ASSET_DIR}`);

  const files = assetNames.map((name) => {
    const content = readFileSync(path.join(ASSET_DIR, name));
    const ext = path.extname(name).substring(1);
    const hash = b3.hash(content.toString('base64') + ext).toString('hex').slice(0, 32);
    return { name, content, hash, contentType: CONTENT_TYPES[`.${ext}`] || 'application/octet-stream' };
  });
  console.log(`assets: ${files.map((f) => `${f.name}(${f.hash.slice(0, 8)})`).join(' ')}`);

  /* ---- 2. upload-token JWT ---- */
  const tok = await api(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/upload-token`);
  const jwt = tok.result.jwt;
  const jwtHeaders = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  /* ---- 3. check-missing / upload / upsert-hashes ---- */
  const hashes = files.map((f) => f.hash);
  const missingRes = await api(`${API}/pages/assets/check-missing`, {
    method: 'POST', headers: jwtHeaders, body: JSON.stringify({ hashes }),
  });
  const missing = new Set(missingRes.result || []);
  const toUpload = files.filter((f) => missing.has(f.hash));

  if (toUpload.length) {
    const payload = toUpload.map((f) => ({
      key: f.hash,
      value: f.content.toString('base64'),
      metadata: { contentType: f.contentType },
      base64: true,
    }));
    await api(`${API}/pages/assets/upload`, {
      method: 'POST', headers: jwtHeaders, body: JSON.stringify(payload),
    });
    console.log(`uploaded ${toUpload.length}/${files.length} asset(s)`);
  } else {
    console.log(`all ${files.length} asset(s) already cached`);
  }

  await api(`${API}/pages/assets/upsert-hashes`, {
    method: 'POST', headers: jwtHeaders, body: JSON.stringify({ hashes }),
  }).catch(() => {}); // non-fatal: only speeds up future deploys

  /* ---- 4. best-effort: clear the stale ORIGIN env var (unused now) ---- */
  try {
    await fetch(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployment_configs: {
        production: { env_vars: { ORIGIN: null } },
        preview: { env_vars: { ORIGIN: null } },
      } }),
    });
    console.log('ORIGIN env clear requested (unused by static deploy)');
  } catch {
    console.log('WARN  could not clear ORIGIN env var — it is unused, safe to ignore');
  }

  /* ---- 5. create the deployment (static-only, no _worker.bundle) ---- */
  const form = new FormData();
  const manifest = {};
  for (const f of files) manifest[`/${f.name}`] = f.hash;
  form.set('manifest', JSON.stringify(manifest));
  form.set('branch', BRANCH);

  const dep = await api(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/deployments`, {
    method: 'POST', body: form,
  });
  const depId = dep.result.id;
  console.log(`deployment ${depId} -> ${dep.result.url}`);

  /* ---- 6. wait for the deploy stage ---- */
  let stage = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await api(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/deployments/${depId}`);
    stage = st.result.latest_stage;
    if (stage?.name === 'deploy' && ['success', 'failure'].includes(stage.status)) break;
  }
  if (!stage || stage.name !== 'deploy' || stage.status !== 'success') {
    fail('deployment did not reach success', stage);
  }
  const alias = (dep.result.aliases || []).find((a) => a.endsWith('.pages.dev'));
  console.log(`DEPLOY OK  ${alias || dep.result.url}`);
}

main().catch((err) => fail(err.message, err.stack));
