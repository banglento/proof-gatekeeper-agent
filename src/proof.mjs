import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as snarkjs from 'snarkjs';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', 'circuit', 'gatekeeper.wasm');
const ZKEY = join(here, '..', 'circuit', 'gatekeeper_final.zkey');

// BN128 (BN254) scalar field modulus.
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Gatekeeper circuit inputs — reverse-engineered from the published
 * artifacts and verified empirically (see PROTOCOL.md §5 and
 * scripts/probe-*.mjs). 13 inputs, ALL mapped:
 *
 *   public inputs (in public-signal order, after the output at index 0):
 *     registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
 *     currentBlock, recipient, conditionRecipient, amount, maxTransfer,
 *     decision, taskId
 *   private input: salt (binds the output commitment at publicSignals[0])
 *
 * The circuit ASSERTS decision == AND(vkMatch, threshold, notExpired,
 * recipientMatch, amountOk). A proof for an inconsistent decision cannot
 * be produced — the circuit is the referee.
 */

/** hex/decimal string (or number) -> field element as decimal string. */
export function toField(v) {
  let b;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number') b = BigInt(Math.trunc(v));
  else {
    const s = String(v).trim();
    b = (s.startsWith('0x') || s.startsWith('0X')) ? BigInt(s) : BigInt(s);
  }
  const r = b % FIELD_P;
  return (r >= 0n ? r : r + FIELD_P).toString(10);
}

/**
 * OPEN ITEM (see PROTOCOL.md §7): the docs never state how the string
 * task_id (e.g. "gk_24_9d1") is encoded into the taskId field element.
 * Encoding implemented here:
 *   - decimal string  -> the integer itself
 *   - 0x hex string   -> the integer value
 *   - anything else   -> sha256(utf8 task_id) mod p  (PLACEHOLDER GUESS)
 * This affects only whether the platform's public-signal comparison
 * matches (reliability bonus), never the decision score. Resolve during
 * practice mode (platform debug history / Discord) before scored rounds.
 */
export function taskIdToField(taskId) {
  const s = String(taskId ?? '').trim();
  if (/^\d+$/.test(s)) return toField(BigInt(s));
  if (/^0x[0-9a-fA-F]+$/.test(s)) return toField(BigInt(s));
  const digest = createHash('sha256').update(s, 'utf8').digest('hex');
  return toField(BigInt('0x' + digest));
}

/** Build the circuit input object from a task payload + decision. */
export function buildCircuitInput(task, decision) {
  const input = task.input;
  return {
    taskId: taskIdToField(task.task_id),
    registeredVkHash: toField(input.registered_vk),
    proofVkHash: toField(input.proof_vk),
    minimum: toField(input.minimum),
    publicBalance: toField(input.public_balance),
    expiryBlock: toField(input.expiry_block),
    currentBlock: toField(input.current_block),
    recipient: toField(input.recipient),
    conditionRecipient: toField(input.condition_recipient),
    amount: toField(input.amount),
    maxTransfer: toField(input.max_transfer),
    decision: decision === 'APPROVE' ? '1' : '0',
    salt: toField(BigInt('0x' + randomBytes(16).toString('hex'))),
  };
}

// Serialize proof generation (CPU-heavy) — at most 2 concurrent.
let active = 0;
const waiters = [];
async function acquire() {
  if (active < 2) { active++; return; }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Generate the Groth16 proof for a decided task.
 * Returns { proof, publicSignals } in snarkjs JSON form.
 * Throws on constraint failure (should be impossible when the decision
 * came from decide() — the caller treats a throw as fail-closed).
 */
export async function generateProof(task, decision) {
  const circuitInput = buildCircuitInput(task, decision);
  await acquire();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY);
    return { proof, publicSignals };
  } finally {
    release();
  }
}
