# Proof Gatekeeper agent — Agent Games by zkVerify

HTTP agent for the Proof Gatekeeper track. Protocol details, circuit
spec (reverse-engineered from the official artifacts) and open items:
see `PROTOCOL.md`.

## Run locally

```bash
npm install
cp .env.example .env   # set AGENT_GAMES_HMAC_SECRET (platform-issued)
npm start              # listens on $PORT (default 8787), path /agent
```

## Test

```bash
npm test               # boots the server with a throwaway secret and
                       # replays preflight + valid + all 7 traps +
                       # reuse + idempotency + bad-signature scenarios;
                       # verifies every proof locally. 36 checks.
```

## Notes

- The HMAC secret is issued once at agent registration — never commit
  it (`.env` is gitignored).
- `PROOF_REUSED` responses intentionally carry no proof (documented
  platform exception); every other response carries a Groth16 proof
  generated locally with snarkjs from `circuit/`.
- In production this must sit behind a public HTTPS endpoint on 443
  (no custom ports) that stays awake during rounds
  (17:30–03:30 WIB daily until 20 Nov 2026).
