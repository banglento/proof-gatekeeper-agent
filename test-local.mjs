/**
 * Local test harness for the Proof Gatekeeper agent.
 *
 * Boots the real server on a scratch port with a throwaway HMAC secret and
 * an isolated store file, then replays:
 *   - preflight handshake
 *   - health check
 *   - the sample task from the event page (made fully valid)
 *   - one task per trap type (7 traps)
 *   - a proof-reuse sequence (valid task, then same proof_tx again)
 *   - an idempotent retry (same task_id twice -> identical raw body)
 *   - a bad-signature request (must be 401)
 *   - a multi-trap priority probe (VK + threshold -> VK_SUBSTITUTION)
 *
 * Every task response is checked for: HTTP 200, valid response HMAC,
 * decision + reason_code, and — for provable tasks — a Groth16 proof that
 * verifies locally against circuit/vk.json with the decision signal set
 * correctly. Exit code 0 only if every scenario passes.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as snarkjs from 'snarkjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'local-test-secret-do-not-use-in-prod';
const STORE_PATH = join(here, 'data', 'test-store.json');
const vk = JSON.parse(readFileSync(join(here, 'circuit', 'vk.json'), 'utf8'));

const VK = '0x7d3a' + '11'.repeat(29) + 'f291';           // registered condition VK
const VK_OTHER = '0xa4c1' + '22'.repeat(29) + 'b8ff';     // substituted VK
const RECIP = '0xDe42' + 'aa'.repeat(17) + '9f01';
const RECIP_OTHER = '0xBeef' + 'bb'.repeat(17) + '1234';

let seq = 0;
function makeTask(overrides = {}, inputOverrides = {}) {
  seq += 1;
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: String(1000 + seq), // numeric on purpose: exact taskId field encoding
    mode: 'practice',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: {
      registered_vk: VK,
      proof_vk: VK,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: RECIP,
      condition_recipient: RECIP,
      amount: '500',
      max_transfer: '1000',
      proof_tx: '0xa4c1' + String(seq).padStart(4, '0') + 'cc'.repeat(27) + '8ff1',
      ...inputOverrides,
    },
    ...overrides,
  };
}

function sign(raw) {
  return createHmac('sha256', SECRET).update(raw).digest('hex');
}

async function post(path, obj, { badSig = false } = {}) {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': badSig ? 'deadbeef' : sign(raw),
    },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, text, json: safeJson(text), sig: res.headers.get('x-agent-games-signature') };
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function verifyProof(respJson, expectedDecisionSignal, label) {
  if (!respJson?.proof || !respJson?.public_signals) {
    check(`${label}: proof present`, false, 'proof/public_signals missing');
    return;
  }
  check(`${label}: proof present`, true);
  const ok = await snarkjs.groth16.verify(vk, respJson.public_signals, respJson.proof);
  check(`${label}: proof verifies vs registered vk`, ok);
  check(`${label}: decision signal`, respJson.public_signals[11] === expectedDecisionSignal,
    `public_signals[11]=${respJson.public_signals[11]}`);
}

async function main() {
  rmSync(STORE_PATH, { force: true });
  const child = spawn('node', [join(here, 'src', 'server.mjs')], {
    env: { ...process.env, AGENT_GAMES_HMAC_SECRET: SECRET, PORT: String(PORT), GK_STORE_PATH: STORE_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  try {
    // wait for readiness
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!up) throw new Error('server did not come up');

    // 1. health
    const health = await (await fetch(`${BASE}/agent`)).json();
    check('health GET /agent', health.ok === true && health.protocolVersion === 'v1');

    // 2. preflight
    const pre = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'abc123' });
    check('preflight status 200', pre.status === 200);
    check('preflight body', pre.json?.ok === true && pre.json?.protocolVersion === 'v1');
    check('preflight response signature valid', pre.sig === sign(pre.text));

    // 3. valid task -> APPROVE + proof
    const validTask = makeTask();
    const valid = await post('/agent', validTask);
    check('valid: status 200', valid.status === 200);
    check('valid: response signature valid', valid.sig === sign(valid.text));
    check('valid: APPROVE/VALID_CONDITION', valid.json?.decision === 'APPROVE' && valid.json?.reason_code === 'VALID_CONDITION',
      `${valid.json?.decision}/${valid.json?.reason_code}`);
    await verifyProof(valid.json, '1', 'valid');
    check('valid: taskId signal', valid.json?.public_signals?.[12] === validTask.task_id,
      `public_signals[12]=${valid.json?.public_signals?.[12]}`);

    // 4. traps (each otherwise valid, fresh proof_tx)
    const traps = [
      ['VK_SUBSTITUTION', { proof_vk: VK_OTHER }],
      ['THRESHOLD_MISMATCH', { public_balance: '999' }],
      ['EXPIRED_CONDITION', { current_block: 19842202 }],
      ['RECIPIENT_MISMATCH', { recipient: RECIP_OTHER }],
      ['AMOUNT_OVERFLOW', { amount: '1500' }],
    ];
    for (const [code, over] of traps) {
      const r = await post('/agent', makeTask({}, over));
      check(`trap ${code}: decision`, r.json?.decision === 'REJECT' && r.json?.reason_code === code,
        `${r.json?.decision}/${r.json?.reason_code}`);
      await verifyProof(r.json, '0', `trap ${code}`);
    }

    // 5. proof reuse: same proof_tx as the valid task, new task_id
    const reuseTask = makeTask({}, { proof_tx: validTask.input.proof_tx });
    const reuse = await post('/agent', reuseTask);
    check('reuse: REJECT/PROOF_REUSED', reuse.json?.decision === 'REJECT' && reuse.json?.reason_code === 'PROOF_REUSED',
      `${reuse.json?.decision}/${reuse.json?.reason_code}`);
    check('reuse: no proof attached (documented exception)', !reuse.json?.proof && !reuse.json?.public_signals);

    // 6. idempotent retry of the valid task -> identical raw body
    const retry = await post('/agent', validTask);
    check('idempotency: identical raw response', retry.text === valid.text);

    // 7. bad signature -> 401
    const bad = await post('/agent', makeTask(), { badSig: true });
    check('bad signature rejected (401)', bad.status === 401, `status=${bad.status}`);

    // 8. multi-trap priority (assumption: VK before threshold)
    const multi = await post('/agent', makeTask({}, { proof_vk: VK_OTHER, public_balance: '1' }));
    check('priority: VK_SUBSTITUTION wins over THRESHOLD_MISMATCH',
      multi.json?.reason_code === 'VK_SUBSTITUTION', multi.json?.reason_code);
  } finally {
    child.kill('SIGTERM');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join('; ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
