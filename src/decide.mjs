/**
 * Deterministic Proof Gatekeeper decision logic.
 *
 * All seven trap types are decidable from the task payload plus the local
 * seen-set (event page: "The test is whether your agent checks every
 * field"). No model is involved in the final call (build-page rule).
 *
 * Priority order when several traps fire at once (ASSUMPTION — the docs do
 * not publish one; task generation appears to plant exactly one trap per
 * task, percentages sum to 100: ~50 valid / 13 vk / 8 threshold / 11 reuse
 * / 6 expired / 6 recipient / 6 amount):
 *   VK_SUBSTITUTION -> THRESHOLD_MISMATCH -> PROOF_REUSED ->
 *   EXPIRED_CONDITION -> RECIPIENT_MISMATCH -> AMOUNT_OVERFLOW
 *
 * Returns { decision, reason_code, checks } where checks holds the five
 * circuit-enforced payload checks, so the proof module can guarantee the
 * circuit input `decision` equals their AND (the circuit asserts this —
 * verified empirically, see PROTOCOL.md §5).
 */
export function decide(input, store) {
  const checks = {
    vkMatch: eqHex(input.proof_vk, input.registered_vk),
    threshold: toBig(input.public_balance) >= toBig(input.minimum),
    notExpired: toBig(input.current_block) <= toBig(input.expiry_block),
    recipientMatch: eqHex(input.recipient, input.condition_recipient),
    amountOk: toBig(input.amount) <= toBig(input.max_transfer),
  };
  const reused = store.hasSeenProofTx(input.proof_tx);

  let decision = 'APPROVE';
  let reason_code = 'VALID_CONDITION';
  if (!checks.vkMatch) { decision = 'REJECT'; reason_code = 'VK_SUBSTITUTION'; }
  else if (!checks.threshold) { decision = 'REJECT'; reason_code = 'THRESHOLD_MISMATCH'; }
  else if (reused) { decision = 'REJECT'; reason_code = 'PROOF_REUSED'; }
  else if (!checks.notExpired) { decision = 'REJECT'; reason_code = 'EXPIRED_CONDITION'; }
  else if (!checks.recipientMatch) { decision = 'REJECT'; reason_code = 'RECIPIENT_MISMATCH'; }
  else if (!checks.amountOk) { decision = 'REJECT'; reason_code = 'AMOUNT_OVERFLOW'; }

  return { decision, reason_code, checks, reused };
}

/** Structural sanity of a task input before any logic runs. */
export function isWellFormedInput(input) {
  if (!input || typeof input !== 'object') return false;
  const fields = ['registered_vk', 'proof_vk', 'minimum', 'public_balance',
    'expiry_block', 'current_block', 'recipient', 'condition_recipient',
    'amount', 'max_transfer', 'proof_tx'];
  return fields.every((f) => input[f] !== undefined && input[f] !== null && input[f] !== '');
}

function eqHex(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function toBig(v) {
  try {
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    const s = String(v).trim();
    return s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s);
  } catch {
    return -1n; // unparseable numeric compares as failing (fail-closed)
  }
}
