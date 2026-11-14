import * as snarkjs from 'snarkjs';
const wasm = 'circuit/gatekeeper.wasm';
const zkey = 'circuit/gatekeeper_final.zkey';
const base = {
  taskId: 12345,
  registeredVkHash: 777001,
  proofVkHash: 777001,
  minimum: 1000,
  publicBalance: 1460,
  expiryBlock: 19842201,
  currentBlock: 19832000,
  recipient: '0xDe42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9f01',
  conditionRecipient: '0xDe42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9f01',
  amount: 500,
  maxTransfer: 1000,
  decision: 1,
  salt: 424242,
};
async function trial(label, overrides) {
  const inp = { ...base, ...overrides };
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inp, wasm, zkey);
    const ok = await snarkjs.groth16.verify(JSON.parse(JSON.stringify((await import('./circuit/vk.json', { with: { type: 'json' } })).default)), publicSignals, proof);
    console.log(label, '=> PROOF OK, verify =', ok);
    console.log('   publicSignals:', JSON.stringify(publicSignals));
  } catch (e) {
    console.log(label, '=> FAIL:', String(e).slice(0, 140));
  }
}
await trial('APPROVE all-valid decision=1', {});
await trial('APPROVE all-valid decision=0', { decision: 0 });
await trial('VK mismatch decision=0', { proofVkHash: 999999, decision: 0 });
await trial('VK mismatch decision=1', { proofVkHash: 999999, decision: 1 });
await trial('APPROVE decision=2 (enum?)', { decision: 2 });
process.exit(0);
