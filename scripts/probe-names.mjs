import * as snarkjs from 'snarkjs';
const wasm = 'circuit/gatekeeper.wasm';
const zkey = 'circuit/gatekeeper_final.zkey';
const candidates = [
  // payload snake_case
  'registered_vk','proof_vk','minimum','public_balance','expiry_block','current_block',
  'recipient','condition_recipient','amount','max_transfer','proof_tx',
  // decision domain
  'decision','reason_code','reason','approve','approved','is_approved','valid','outcome',
  // camelCase variants
  'registeredVk','proofVk','publicBalance','expiryBlock','currentBlock','conditionRecipient',
  'maxTransfer','proofTx','reasonCode',
  // hash/other variants
  'vk_hash','vkHash','registeredVkHash','proofVkHash','balance','threshold','min_balance',
  'task_id','taskId','task_hash','expiry','block','sender','agent','nonce','timestamp',
  'proof_hash','proofHash','tx_hash','condition_vk','conditionVk','expected_vk','target_vk',
  'decision_code','decisionCode','approve_flag','checks_passed','all_checks_pass',
];
const valid = [];
for (const name of candidates) {
  try {
    await snarkjs.groth16.fullProve({ [name]: 1 }, wasm, zkey);
    valid.push(name + ' (full success?!)');
  } catch (e) {
    const msg = String(e);
    if (msg.includes('Not all inputs have been set')) valid.push(name);
    else if (!msg.includes('Too many values')) valid.push(name + ' (other err: ' + msg.slice(0,80) + ')');
  }
}
console.log('VALID INPUT NAMES:', JSON.stringify(valid, null, 1));
process.exit(0);
