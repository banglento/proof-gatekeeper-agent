# PROVEKEEPER — Wildcard write-up

**Track:** Wildcard (built for Proof Gatekeeper)
**Agent:** PROVEKEEPER, by @wanmusher
**Code:** this repository (public, MIT-style competition entry)
**Live endpoint:** registered in the Agent Games dashboard (HTTPS, HMAC-signed)

## What it does

PROVEKEEPER is an autonomous agent for the Proof Gatekeeper track of
Agent Games by zkVerify. The platform dispatches signed payment-approval
tasks; the agent verifies the request signature, decides **APPROVE** or
**REJECT** with a machine-readable reason code, and returns a real
**Groth16 proof** (BN254, generated locally with snarkjs) that the
platform verifies inline against its registered verification key.

Every response is signed with the agent's platform-issued HMAC secret
(`x-agent-games-signature`, HMAC-SHA256 over the raw body).

## The decision engine

Implements all seven documented trap classes:

| Case | Detection | Decision |
| --- | --- | --- |
| Valid condition | every field agrees | APPROVE |
| VK substitution | `proof_vk != registered_vk` | REJECT |
| Proof reused | `proof_tx` in the persistent seen-set | REJECT, no proof (documented platform exception) |
| Threshold mismatch | `public_balance < minimum` | REJECT |
| Expired condition | `current_block > expiry_block` | REJECT |
| Recipient mismatch | `recipient != condition_recipient` | REJECT |
| Amount overflow | `amount > max_transfer` | REJECT |

Multi-trap tasks are resolved with a fixed, documented priority order.
Task IDs are treated as idempotency keys: a retried task returns the
byte-identical response instead of re-deciding.

## The circuit work (the interesting part)

The proving circuit's interface was not fully documented, so it was
reverse-engineered from the official artifacts (`vk.json`, the wasm and
zkey in `circuit/`) and the platform's circuit-info endpoint, then
verified empirically:

- **13 public signals** in a fixed order: a commitment output, the 11
  payload fields (VK hashes, minimum, balance, blocks, recipient pair,
  amount, max transfer), the decision, and the task ID — plus one
  private input (salt).
- The circuit **asserts** `decision == AND(vkMatch, balance >= minimum,
  currentBlock <= expiryBlock, recipientMatch, amount <= maxTransfer)`.
  Consequence: trap rejections can (and must) still carry a *valid*
  proof, while a pure proof-reuse rejection mathematically cannot —
  which is exactly the exception the platform documents.
- Witness generation + proving takes **< 1 s per proof** on a small VM,
  comfortably inside the 60 s task deadline.

Full protocol notes, including sources for every claim and the open
items found along the way (task-ID field encoding, HMAC digest format —
both to be confirmed against practice-mode traffic), are in
[`PROTOCOL.md`](PROTOCOL.md).

## Reliability

- Persistent seen-set + decision store (atomic file writes) — restarts
  don't lose reuse detection or idempotency.
- Health surface answers `GET /agent` and `GET /healthz` with
  `{"ok":true,"protocolVersion":"v1"}`.
- An external watchdog checks the public endpoint every 5 minutes and
  restores the server/tunnel if either dies.

## Testing

`npm test` boots the server with a throwaway secret and replays:
health, a signed preflight, a valid approval (proof verified locally),
all payload traps (each with a locally verified REJECT proof), the
reuse sequence, an idempotent retry, and a bad-signature request
(401). **36/36 checks pass.**
