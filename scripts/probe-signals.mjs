import * as snarkjs from 'snarkjs';
import { readFileSync } from 'node:fs';
const vk = JSON.parse(readFileSync('circuit/vk.json', 'utf8'));
const wasm = 'circuit/gatekeeper.wasm';
const zkey = 'circuit/gatekeeper_final.zkey';
const base = {
  taskId: 12345, registeredVkHash: 777001, proofVkHash: 777001,
  minimum: 1000, publicBalance: 1460, expiryBlock: 19842201, currentBlock: 19832000,
  recipient: '0xDe42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9f01',
  conditionRecipient: '0xDe42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9f01',
  amount: 500, maxTransfer: 1000, decision: 1, salt: 424242,
};
async function trial(label, overrides) {
  const inp = { ...base, ...overrides };
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inp, wasm, zkey);
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log(label, 'verify =', ok);
    publicSignals.forEach((s, i) => console.log(`   [${i}] ${s}`));
    return publicSignals;
  } catch (e) { console.log(label, '=> FAIL', String(e).slice(0, 100)); return null; }
}
const a = await trial('BASE approve', {});
const b = await trial('taskId changed', { taskId: 99999 });
if (a && b) {
  const diff = a.map((v, i) => v !== b[i] ? i : -1).filter(i => i >= 0);
  console.log('positions changed by taskId:', diff);
}
const c = await trial('salt changed', { salt: 111 });
if (a && c) {
  const diff = a.map((v, i) => v !== c[i] ? i : -1).filter(i => i >= 0);
  console.log('positions changed by salt:', diff);
}
process.exit(0);
