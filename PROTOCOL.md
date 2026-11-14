# Agent Games — Proof Gatekeeper: Protocol Notes

Compiled 2026-11-14 from the official docs, plus **empirical reverse
engineering of the published circuit artifacts** (marked where used).
Nothing in §5–§6 that is labelled "verified" rests on documentation
alone — it was reproduced locally with the real `.wasm`/`.zkey`.

Sources:
- [RULES] https://agentgames.zkverify.io/rules
- [BUILD] https://agentgames.zkverify.io/build (incl. the official
  "starter prompt" code block and the Kurier code sample embedded in
  the page payload)
- [GUIDE] https://agentgames.zkverify.io/guide
- [EVENT] https://agentgames.zkverify.io/events/proof-gatekeeper
- [CIRCUITS] https://agentgames.zkverify.io/api/circuit-info

---

## 1. Competition shape

- Entry is free; one account per person/team, one GitHub account per
  competition account; multiple accounts in the same event =
  disqualification. [RULES §1.1, §1.5]
- Prize eligibility requires a **connected GitHub account** and a
  **connected wallet address** (wallet needed to claim VFY). Winners
  are verified manually after standings freeze. [RULES §1.1; GUIDE]
- Proof Gatekeeper: 100,000 VFY per track, split 50k / 30k / 20k.
  [EVENT]
- **8 scored rounds, 13–20 Nov 2026, 4:00 PM–2:00 AM IST daily
  (= 17:30–03:30 WIB), 8 tasks per agent per round, scores
  cumulative.** Round 01 (13 Nov) is already complete and Round 02
  (14 Nov) was LIVE when these notes were written. [EVENT]
- Practice mode: identical task format, no leaderboard effect, capped
  at **10 dispatches per active agent per hour**, leaves a record in
  the debugging history. Available ahead of scored rounds. [RULES §1.7]
- Entry prerequisites: authenticated account, **registered HTTPS
  endpoint passing a health check**, **completed signed preflight**,
  **at least one practice task**, endpoint responds within 60 s under
  load, one agent per owner, entries lock while a round is open.
  [EVENT "Before you can compete"]

## 2. Transport & signing

- The platform never runs your code. You host the agent at a **public
  HTTPS address** — no localhost, no private IPs, **no custom ports** —
  and register the **full handler path** (e.g. `/agent`, not the root);
  the platform POSTs to the URL exactly as registered. [RULES §1.2;
  BUILD card 01]
- At agent registration the platform generates a **32-byte HMAC
  secret, shown exactly once**. The platform keeps an AES-256-GCM
  encrypted copy. Rotate from agent settings if compromised; the old
  secret stops working immediately. Never commit it. [RULES §1.3]
- Every inbound request carries header **`x-agent-games-signature`** =
  HMAC-SHA256 over the **raw request body**. Verify it **before**
  parsing JSON. [BUILD starter prompt item 2; BUILD Security checklist]
- **Every response must be signed the same way** over the raw response
  body, header `x-agent-games-signature`. [BUILD card 05; Security
  checklist]
- Encoding assumption: hex digest (per protocol brief). The scaffold
  accepts hex and (defensively) base64 on inbound verification, and
  always emits hex. To be confirmed in practice mode.
- **Task IDs are idempotency keys** — the platform may retry after a
  network failure; a retry must be answered consistently. [RULES §1.2]
- If the agent is offline when a task is delivered, the task is
  forfeited (after platform retries). Free-tier hosts that sleep will
  cost tasks. Uptime history is public on the agent profile.
  [RULES §1.4]
- Manual play is prohibited; response-time limits are set to make
  human-in-the-loop impractical. [RULES §1.6]
- **Hard response deadline: 60 seconds.** Fail closed: on timeout,
  error or uncertainty, REJECT — never approve by default.
  [BUILD §02; starter prompt]

### Preflight handshake [BUILD code block]

Request (platform → agent, signed like any task):

```json
{ "type": "agent-games.preflight.v1", "agent_id": "agt_...",
  "issued_at": "...", "nonce": "abc123" }
```

Required response (signed):

```json
{ "ok": true, "protocolVersion": "v1" }
```

Flow: deploy → rotate secret on the dashboard → set
`AGENT_GAMES_HMAC_SECRET` → restart agent → run preflight; it must
pass before the platform marks the agent ready. [BUILD card 06]

## 3. Task envelope [EVENT sample; BUILD code block]

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_24_9d1",
  "mode": "competition",
  "issued_at": "<ts>",
  "deadline_at": "<ts>",
  "input": {
    "registered_vk": "0x…",        // VK the condition was registered with
    "proof_vk": "0x…",             // VK the presented proof actually used
    "minimum": "1000",             // required minimum balance (decimal string)
    "public_balance": "1460",      // balance disclosed by the proof
    "expiry_block": 19842201,
    "current_block": 19832000,
    "recipient": "0x…",            // recipient committed in the proof
    "condition_recipient": "0x…",  // recipient on the payment condition
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0x…"              // on-chain reference of the gated proof
  }
}
```

(`mode` is `"practice"` for practice tasks [RULES §1.7]; samples show
truncated hex — real values are full-length.)

## 4. Decisions & scoring [EVENT]

Response shape (documented sample):

```json
{ "decision": "REJECT", "reason_code": "VK_SUBSTITUTION", "proof_tx": "0x…" }
```

plus, on every provable task, the proof fields of §5. `proof_tx` in
the response echoes the task's reference and is an **optional on-chain
audit pointer**. [BUILD card 05; starter prompt item 6]

| Case | Rule (all decidable from the payload + local seen-set) |
|---|---|
| VALID_CONDITION → APPROVE | every check passes |
| VK_SUBSTITUTION | `proof_vk != registered_vk` (case-insensitive) |
| THRESHOLD_MISMATCH | `public_balance < minimum` |
| PROOF_REUSED | `proof_tx` already seen in a previous task — record every processed reference as seen |
| EXPIRED_CONDITION | `current_block > expiry_block` |
| RECIPIENT_MISMATCH | `recipient != condition_recipient` |
| AMOUNT_OVERFLOW | `amount > max_transfer` |

Trap mix ≈ 50% valid / 13% VK / 8% threshold / 11% reused / 6%
expired / 6% recipient / 6% amount — i.e. tasks appear to plant
exactly one trap each. **The docs publish no priority order for
multi-trap collisions; the scaffold's order is an assumption**
(VK → THRESHOLD → REUSED → EXPIRED → RECIPIENT → AMOUNT), see
`src/decide.mjs`.

Scoring per task: correct decision **+12** (approve and reject score
equally); wrong APPROVE **−6**; wrong REJECT **−3**; timeout **−2**;
**missing/invalid proof −2**; **reliability bonus 0..+5** per round,
pro-rated by the share of provable tasks whose Groth16 proof verified
against the registered key. **PROOF_REUSED tasks have no proof to
submit and are excluded from the bonus/penalty.** Ties break on
(1) more correct decisions, (2) fewer timeouts. [EVENT score model]

## 5. The agent's own Groth16 proof — response format & circuit spec

Response (starter prompt item 6, [BUILD]):
`{ decision, reason_code, proof, public_signals }`, signed — where
`proof` is the snarkjs Groth16 proof object (`pi_a`, `pi_b`, `pi_c`,
protocol "groth16", curve "bn128") and `public_signals` is the array
of decimal strings returned by snarkjs. The platform **independently
re-verifies the proof against its own registered verification key**
and scores the decision separately — "the circuit is the referee".
[BUILD §01.5, card 05]

Circuit artifacts [CIRCUITS; BUILD §02.5]:

```json
{ "network": "mainnet",
  "circuits": {
    "gatekeeper": {
      "vkHash": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
      "artifacts": {
        "wasm": "https://agentgames.zkverify.io/circuits/gatekeeper.wasm",
        "zkey": "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey" } },
    "vfyPolicy": { "vkHash": "0x6c5650…be047", "artifacts": { … } }  // Steal the VFY
  } }
```

Groth16 / BN128, Circom 2.x; proofs are generated locally with
snarkjs. Local copies (sha256):
`circuit/gatekeeper.wasm` (1,755,820 B,
`be00aefe…64f`), `circuit/gatekeeper_final.zkey` (309,750 B,
`adfe95a4…80d`), exported VK in `circuit/vk.json`.

### Circuit inputs — REVERSE-ENGINEERED & VERIFIED (not in the docs)

The docs never list the gatekeeper circuit's inputs. They were
recovered from the artifacts themselves (probing scripts in
`gatekeeper/scripts/`):

- Exported VK: **13 public signals** (IC length 14).
- The witness calculator reports exactly **13 inputs to set**.
- Name-probing (a set name is accepted iff it exists) recovered all
  13 input names, and full proofs were generated and verified locally
  (`snarkjs.groth16.verify` against the exported VK = **true**).

Inputs (12 public + 1 private):

| Input | From task field | Notes |
|---|---|---|
| `registeredVkHash` | `input.registered_vk` | hex → field element |
| `proofVkHash` | `input.proof_vk` | hex → field element |
| `minimum` | `input.minimum` | decimal string |
| `publicBalance` | `input.public_balance` | decimal string |
| `expiryBlock` | `input.expiry_block` | |
| `currentBlock` | `input.current_block` | |
| `recipient` | `input.recipient` | address → integer |
| `conditionRecipient` | `input.condition_recipient` | address → integer |
| `amount` | `input.amount` | |
| `maxTransfer` | `input.max_transfer` | |
| `decision` | agent's decision | **1 = APPROVE, 0 = REJECT** |
| `taskId` | `task_id` | encoding: see §7 open item |
| `salt` | — (private) | random; binds the output commitment |

`public_signals` layout (empirically mapped by varying one input at
a time):

```
[0]  output commitment — in-circuit hash over the inputs incl. salt
     and taskId (changes iff taskId or salt changes); computed BY the
     circuit, never supplied by the agent
[1]  registeredVkHash    [7]  recipient
[2]  proofVkHash         [8]  conditionRecipient
[3]  minimum             [9]  amount
[4]  publicBalance       [10] maxTransfer
[5]  expiryBlock         [11] decision
[6]  currentBlock        [12] taskId
```

**Circuit semantics (verified):** witness generation **asserts**
(template `GatekeeperEvaluation`, line 102) unless

```
decision == (proofVkHash == registeredVkHash)
         AND (publicBalance >= minimum)
         AND (currentBlock <= expiryBlock)
         AND (recipient == conditionRecipient)
         AND (amount <= maxTransfer)
```

- All-valid + `decision=1` → proves & verifies. All-valid +
  `decision=0` → **assert fails** (a valid condition cannot be
  reject-proved). VK-mismatch + `decision=1` → **assert fails**;
  VK-mismatch + `decision=0` → proves & verifies. `decision=2` →
  assert fails.
- Consequences: (a) a trap REJECT (any of the 5 payload traps) can and
  must carry a valid proof; (b) a PROOF_REUSED-only rejection
  (payload checks all pass, so the circuit would demand decision=1)
  **cannot** carry a proof — exactly matching the documented
  exclusion of PROOF_REUSED from the proof requirement. The design is
  self-consistent.
- Field encoding: values are reduced mod the BN254 scalar prime
  `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
  256-bit VK hashes exceed `p`; both VK sides reduce identically, so
  the equality check is unaffected (collision probability negligible).
- Proof generation time on this VM: **< 1 s per proof** — far inside
  the 60 s deadline.

## 6. zkVerify / Kurier — what is actually required?

Two different things appear in the docs and are easy to conflate:

**(a) Confirming the TASK's proof on-chain.** Event-page build
checklist item 02: "Call zkVerifyJS to confirm the proof is on-chain
and its VK matches the registered condition VK"; build Security
checklist: "The verification reached a finalized state before
approval." This is a **design recommendation / defence-in-depth**,
not a scoring input: the scoring model (§4) grades the decision +
the agent's inline proof, and the event page frames the test as
"whether your agent checks every field" — all seven traps are
decidable from the payload + local seen-set. It is also impractical
to gate a 60 s response on a mainnet finalization round-trip. The
scaffold does **not** do this by default.
Cost if enabled: Kurier path needs a **mainnet Kurier API key**
(https://api.kurier.xyz — account/API key creation is a separate
step, NOT done here); zkVerifyJS path needs a **funded Volta /
zkVerify account** (seed phrase + VFY for fees). [BUILD §03]

**(b) Submitting OUR decision proof to zkVerify.** Build §03
presents Kurier (recommended) vs zkVerifyJS as "your verification
path", and the starter prompt lists a zkVerify submission step. But
the score model says the **platform re-verifies the inline proof
against the registered key**, and the response spec calls `proof_tx`
an *optional* audit pointer. Conclusion: **on-chain submission of
our proof is optional** (audit trail), not required for the proof to
count. The scaffold ships a disabled stub (`src/kurier.mjs`) with
the request shape copied verbatim from the build page's own sample:

```
POST https://api.kurier.xyz/api/v1/submit-proof/{KURIER_API_KEY}
{ "proofType": "groth16", "vkRegistered": true,
  "proofOptions": { "library": "snarkjs", "curve": "bn128" },
  "proofData": { "proof": …, "publicSignals": …, "vk": <vkHash> } }
→ poll the returned job until status "Finalized"
```

## 7. Open items / unresolved dependencies

1. **`taskId` field encoding (critical, proof-only).** Docs never say
   how the string `task_id` (e.g. `"gk_24_9d1"`) maps to the circuit's
   `taskId` field element. Scaffold: decimal/0x strings → integer;
   anything else → `sha256(task_id) mod p` (**placeholder guess**,
   `src/proof.mjs: taskIdToField`). A wrong guess costs only the
   reliability bonus (platform's expected public signals won't match
   ours), never the ±12 decision score. Resolve via practice mode:
   the platform's debugging history may show expected signals; else
   ask in the zkVerify Discord (https://discord.gg/zkverify).
2. **HMAC digest encoding** — hex assumed; base64 also accepted
   inbound. Confirm in practice (preflight would fail otherwise).
3. **Kurier API key / zkVerifyJS funded account** — only needed if
   the optional paths of §6 are ever enabled. Not created.
4. **Trap priority order** — unpublished; scaffold assumption in §4.
   Only matters for multi-trap tasks, which the published mix
   suggests do not exist.
5. **Health-check mechanics** — docs require a "passing health
   check" without specifying method/path; the scaffold answers
   `GET /agent` and `GET /healthz` with `{ ok: true, … }`. The
   preflight POST is the documented handshake and is implemented.
6. **Hosting** — needs a public HTTPS endpoint on 443 in front of
   this service (rules §1.2/§1.4: no custom ports, no sleeping
   hosts). Tunnel/reverse-proxy choice is a deployment decision,
   out of scope for this scaffold.
7. **Account-side steps (not done, by design):** register at
   /register (X or wallet sign-in), connect GitHub + wallet for
   prize eligibility, create the agent, register the endpoint URL,
   copy the one-time HMAC secret into `.env`, run preflight +
   ≥1 practice task before scored rounds.

## 8. Scaffold map (`gatekeeper/`)

```
src/server.mjs   HTTP server (node:http, no framework): HMAC verify ->
                 preflight | task handler; fail-closed everywhere;
                 50 s soft proof timeout vs the 60 s hard deadline.
src/hmac.mjs     HMAC-SHA256 sign/verify over raw bodies.
src/decide.mjs   Deterministic 7-trap decision logic + priority.
src/proof.mjs    Circuit input mapping + snarkjs fullProve (max 2
                 concurrent), taskId encoding (open item §7.1).
src/store.mjs    Persistent JSON store: seen proof_tx set +
                 task_id -> raw response (idempotency), atomic writes.
src/kurier.mjs   Disabled optional Kurier stub (§6).
circuit/         gatekeeper.wasm, gatekeeper_final.zkey, vk.json.
scripts/         The probing scripts that recovered §5 (kept as
                 evidence/documentation).
test-local.mjs   Local harness — see its header. 36/36 checks pass.
.env.example     AGENT_GAMES_HMAC_SECRET / PORT / KURIER_API_KEY.
```
