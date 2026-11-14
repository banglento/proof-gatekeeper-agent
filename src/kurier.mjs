/**
 * OPTIONAL Kurier integration — NOT required for scoring (see
 * PROTOCOL.md §6). Two distinct uses exist in the docs and are easy to
 * confuse:
 *
 *  (a) Confirming the TASK's proof (proof_tx) is on-chain/finalized on
 *      zkVerify before approving — the event-page build checklist item 02.
 *      Defence-in-depth only: all seven traps are decidable from the
 *      payload + local seen-set, and a mainnet round-trip cannot be
 *      relied on inside the 60-second deadline.
 *  (b) Submitting OUR decision proof to zkVerify for an on-chain audit
 *      reference (the response's optional proof_tx / proofReference
 *      pointer). The score model re-verifies the inline proof against
 *      the registered key, so this is not wired into the response path.
 *
 * This module is a disabled-by-default stub: with no KURIER_API_KEY it
 * does nothing. The submit-proof request shape below is copied verbatim
 * from the code sample on the build page so enabling it later is a
 * small, reviewed change — do NOT enable it blind.
 */
const API_URL = 'https://api.kurier.xyz/api/v1';

export function kurierEnabled() {
  return Boolean(process.env.KURIER_API_KEY);
}

export async function submitProofToKurier({ proof, publicSignals, vkHash }) {
  if (!kurierEnabled()) return null;
  const res = await fetch(`${API_URL}/submit-proof/${process.env.KURIER_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proofType: 'groth16',
      vkRegistered: true,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: vkHash },
    }),
  });
  return res.json(); // { jobId / id, status, ... } — poll until "Finalized"
}
