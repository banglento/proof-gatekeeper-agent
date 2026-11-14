import * as snarkjs from 'snarkjs';
const wasm = 'circuit/gatekeeper.wasm';
const zkey = 'circuit/gatekeeper_final.zkey';
const candidates = [
  'proofTxHash','proofReference','proofRef','proofId','reference','ref','proof','txHash','tx_hash',
  'seen','reused','proofUsed','proofSeen','conditionHash','commitment','commitmentHash',
  'inputsHash','publicInputsHash','payloadHash','taskHash','id','round','agentId','owner',
  'validProof','proofValid','vkMatch','thresholdMet','expired','checks','flags','mode','type',
  'deadlineBlock','blockNumber','chainId','version','circuitVersion','minBalance','balanceHash',
  'recipientHash','conditionRecipientHash','amountHash','salt','seed','random','challenge',
  'publicInputs','inputs','values','vk','registeredVk','proofVk','condition','transfer','payment',
  'approval','approvedFlag','isValid','ok','pass','result','status','code','reasonCodeHash',
  'decisionHash','decision_code','approveDecision','gateDecision','verdict','ruling',
];
const valid = [];
for (const name of candidates) {
  try {
    await snarkjs.groth16.fullProve({ [name]: 1 }, wasm, zkey);
    valid.push(name + ' (full success?!)');
  } catch (e) {
    const msg = String(e);
    if (msg.includes('Not all inputs have been set')) valid.push(name);
    else if (!msg.includes('Too many values')) valid.push(name + ' (other: ' + msg.slice(0,100) + ')');
  }
}
console.log('BATCH2 VALID:', JSON.stringify(valid, null, 1));
process.exit(0);
