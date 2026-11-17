#!/usr/bin/env node
/**
 * Deploy the Confide UI + proxy worker to Cloudflare Pages.
 *
 * Replicates what `wrangler pages deploy` does against the Pages API, without
 * needing wrangler/npm:
 *   1. fetch an upload-token JWT for the project
 *   2. hash each asset with wrangler's hashFile: BLAKE3(base64(content) + ext)[0:32]
 *   3. /pages/assets/check-missing -> upload -> upsert-hashes
 *   4. POST the deployment (manifest + branch + _worker.bundle)
 *   5. set the ORIGIN env var that _worker.js uses to reach the origin server
 *
 * Usage:
 *   CF_TOKEN=<pages api token> \
 *   CF_ACCOUNT=<account id> \
 *   CF_PROJECT=soldchats \
 *   ORIGIN=https://<current-tunnel-url> \
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
const ORIGIN = (process.env.ORIGIN || '').replace(/\/+$/, '');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'public');          // the live UI source
const WORKER_PATH = path.join(ROOT, 'pages-build', '_worker.js'); // Pages proxy worker
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
  if (!ORIGIN) fail('ORIGIN is not set (the public origin URL, e.g. the cloudflared tunnel)');

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

  const workerSrc = readFileSync(WORKER_PATH, 'utf8');

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

  /* ---- 4. set the ORIGIN env var (verified) ---- */
  if (ORIGIN) {
    // Pages env_vars values are {type, value} objects, nested under
    // deployment_configs.<environment>
    const attempts = [
      { deployment_configs: { production: { env_vars: { ORIGIN: { type: 'plain_text', value: ORIGIN } } } } },
      { deployment_configs: {
          production: { env_vars: { ORIGIN: { type: 'plain_text', value: ORIGIN } } },
          preview: { env_vars: { ORIGIN: { type: 'plain_text', value: ORIGIN } } },
      } },
    ];
    let set = false;
    for (const body of attempts) {
      // raw fetch: a rejected shape must fall through to the next attempt,
      // not abort the deploy
      try {
        const res = await fetch(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) continue;
      } catch { continue; }
      const check = await api(`${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}`);
      const current = check.result?.deployment_configs?.production?.env_vars?.ORIGIN;
      const currentValue = typeof current === 'object' ? current?.value : current;
      if (currentValue === ORIGIN) { set = true; break; }
    }
    console.log(set ? `ORIGIN env set: ${ORIGIN}` : 'WARN  could not verify ORIGIN env var — check it in the dashboard');
  }

  /* ---- 5. create the deployment ---- */
  const form = new FormData();
  const manifest = {};
  for (const f of files) manifest[`/${f.name}`] = f.hash;
  form.set('manifest', JSON.stringify(manifest));
  form.set('branch', BRANCH);

  // _worker.bundle is itself a multipart body: metadata + the ESM module,
  // exactly how wrangler packages an advanced-mode _worker.js
  const inner = new FormData();
  inner.set('metadata', JSON.stringify({ main_module: '_worker.js' }));
  inner.set('_worker.js', new Blob([workerSrc], { type: 'application/javascript+module' }), '_worker.js');
  const innerBlob = await new Response(inner).blob();
  form.set('_worker.bundle', innerBlob, '_worker.bundle');

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
