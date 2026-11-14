import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signBody, verifyBodySignature } from './hmac.mjs';
import { Store } from './store.mjs';
import { decide, isWellFormedInput } from './decide.mjs';
import { generateProof } from './proof.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---
const envFile = join(here, '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const AGENT_PATH = process.env.AGENT_PATH ?? '/agent';
if (!SECRET) {
  console.error('[gatekeeper] AGENT_GAMES_HMAC_SECRET is not set — refusing to start (copy .env.example to .env).');
  process.exit(1);
}

const store = new Store(process.env.GK_STORE_PATH ?? join(here, '..', 'data', 'store.json'));
const PROOF_SOFT_TIMEOUT_MS = 50_000; // respond before the 60s hard deadline

function sendSigned(res, status, rawBody) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-agent-games-signature': signBody(SECRET, rawBody),
  });
  res.end(rawBody);
}

function sendJson(res, status, obj) {
  sendSigned(res, status, JSON.stringify(obj));
}

async function handleTask(task) {
  const taskId = String(task?.task_id ?? '');

  // Idempotency: task_id is the key — a retry gets the stored response.
  if (taskId) {
    const stored = store.getResponse(taskId);
    if (stored) return stored;
  }

  let responseObj;
  try {
    if (!taskId || task.type !== 'agent-games.proof-gatekeeper.v1' || !isWellFormedInput(task.input)) {
      // Fail closed on malformed envelopes.
      responseObj = { decision: 'REJECT', reason_code: 'MALFORMED_TASK' };
    } else {
      const { decision, reason_code } = decide(task.input, store);
      responseObj = { decision, reason_code, proof_tx: task.input.proof_tx };

      // Every provable task must carry our Groth16 proof (+12 needs it for
      // the reliability bonus; missing/invalid proof costs an extra -2).
      // PROOF_REUSED is the documented exception: "tasks have no proof to
      // submit and are excluded" (event page, score model).
      if (reason_code !== 'PROOF_REUSED') {
        try {
          const { proof, publicSignals } = await withTimeout(
            generateProof(task, decision), PROOF_SOFT_TIMEOUT_MS);
          responseObj.proof = proof;
          responseObj.public_signals = publicSignals;
        } catch (err) {
          // Fail closed: keep the (deterministic) decision, drop the proof,
          // log loudly. Never hang past the deadline.
          console.error(`[gatekeeper] proof generation failed for ${taskId}:`, err?.message ?? err);
          delete responseObj.proof;
          delete responseObj.public_signals;
        }
      }

      // Record the reference as seen exactly once, whatever the outcome.
      store.markProofTxSeen(task.input.proof_tx);
    }
  } catch (err) {
    console.error(`[gatekeeper] internal error for ${taskId}:`, err);
    responseObj = { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' };
  }

  const raw = JSON.stringify(responseObj);
  if (taskId) {
    store.saveResponse(taskId, raw);
    try { store.flush(); } catch (e) { console.error('[gatekeeper] store flush failed:', e?.message ?? e); }
  }
  return raw;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`soft timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Health check (entry requirement: "registered endpoint with a passing
  // health check"). GET has no body to sign; body is informational.
  if (req.method === 'GET' && (url.pathname === AGENT_PATH || url.pathname === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocolVersion: 'v1', agent: 'proof-gatekeeper' }));
    return;
  }

  if (req.method !== 'POST' || url.pathname !== AGENT_PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);

    // Verify HMAC over the RAW body BEFORE parsing (build-page rule).
    const sig = verifyBodySignature(SECRET, rawBody, req.headers['x-agent-games-signature']);
    if (!sig.ok) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid signature' }));
      return;
    }

    let msg;
    try { msg = JSON.parse(rawBody.toString('utf8')); }
    catch {
      sendJson(res, 200, { decision: 'REJECT', reason_code: 'MALFORMED_TASK' });
      return;
    }

    try {
      if (msg.type === 'agent-games.preflight.v1') {
        sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
        return;
      }
      const raw = await handleTask(msg);
      sendSigned(res, 200, raw);
    } catch (err) {
      console.error('[gatekeeper] unhandled error:', err);
      sendJson(res, 200, { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
    }
  });
  req.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
});

server.listen(PORT, () => {
  console.log(`[gatekeeper] listening on :${PORT}${AGENT_PATH} (proof circuit loaded lazily per task)`);
});
