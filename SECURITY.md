# Security and threat model

GuideSats lets software (an AI agent) spend a traveller's sats. The whole design starts from one rule:
**the agent may only spend inside a mandate the traveller approved, and nothing the agent can reach can approve, widen or re-arm a mandate.**

Status: hackathon prototype. The money path is tested on a SIMULATED Lightning backend. The Nostr Wallet Connect adapter is written and unit-tested against a fake client, but it has not yet been run against real wallets.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Traveller's sats | Traveller's own Lightning wallet (reached through NWC) | Theft or overspending |
| NWC connection strings (contain a secret) | `.env` on the machine that runs the server (git-ignored), read from env vars only | Whoever holds one can use that wallet within its permissions |
| Preimage P (the "meeting code") | Made by the traveller's phone (browser CSPRNG), kept in its local storage; shown to the guide at the meeting | Whoever holds P can settle the hold, so the guide gets paid only when the traveller is there |
| Mandate (cap, payee key, time window, single use, H) | Server store (`node:sqlite`) | It is the agent's whole spending authority |
| Personal data (traveller name, contact) | Not collected by this prototype | No PII in logs, by design |

## Actors and trust

- **Traveller**: owns the money and is the only one who approves a mandate (`/api/traveller/*`).
- **Guide**: receives a hold invoice and settles it with P (`/api/guide/*`).
- **Agent**: untrusted for authority. It plans and calls tools (`src/agent/tools.ts`), and may be wrong or manipulated (prompt injection, if an LLM planner is added later).
- **Server**: trusted to enforce the mandate. In this prototype it runs on the traveller's own machine and binds to 127.0.0.1.
- **Wallets / NWC relay**: the wallet enforces its own permissions and, when it offers one, a budget.
- **GDACS feed**: public, unauthenticated data; it can cancel and refund, but it can never pay.

## Threats and mitigations

| # | Threat | Mitigation | Where | Tested by |
|---|---|---|---|---|
| T1 | The agent pays more than agreed | Mandate cap; the invoice amount must equal the booking price exactly; integer sats only; no amountless invoices | `domain/mandate.ts`, `ln/invoiceCheck.ts`, `app/payments.ts` | `tests/domain/mandate.test.ts`, `tests/ln/invoiceCheck.test.ts`, property test |
| T2 | The agent pays someone else (a swapped or forged invoice) | The payee is the key **recovered from the invoice signature** and must equal the mandate's payee. Payment hash must equal the H the traveller approved. Network prefix must match. | `ln/bolt11.ts`, `ln/invoiceCheck.ts` | BOLT11 spec vector, property test |
| T3 | The agent pays twice (retry, replay, race) | Single-use mandate reserved with an atomic compare-and-set **before** the first await; definite failures re-arm it, unknown outcomes (timeouts) do not | `app/payments.ts`, `store/db.ts` | concurrent-payment test, property test |
| T4 | The agent approves or raises its own mandate | No such tool exists. Tools get a closure-only facade with no handle on the store, the wallet or the approval function. Unknown tool names are refused. | `agent/tools.ts` | structure tests in `tests/agent/planner.test.ts` |
| T5 | The agent pays outside the agreed time | Mandate window (from 12 h before the tour to its start) | `domain/mandate.ts` | mandate tests, property test (clock jumps) |
| T6 | Money locked while a cyclone is coming | The cyclone rule is checked before every lock; an alert after the lock cancels the hold (automatic refund) | `domain/cyclone.ts`, `app/service.ts` | recorded GDACS fixtures, service tests |
| T7 | The guide takes the money without showing up | Hold invoice: the guide can settle only with P, which the traveller shows at the meeting. If the hold is never settled it expires and the sats return. | `app/service.ts` (`settleWithPreimage`) | service tests |
| T8 | Secrets or PII leak into logs | Redacting logger: secret and PII keys removed whatever their value; NWC strings, emails, phone numbers and stray 64-hex values (preimages) scrubbed inside any string; invoices shortened. The audit table stores redacted fields only. | `log/redact.ts`, `store/db.ts` | snapshot test, audit test |
| T9 | Connection strings leak | Read only from env vars (`.env.example` has empty placeholders, `.env` is git-ignored); never logged; never echoed in errors; the SDK is imported only on the opt-in real path | `ln/nwc.ts`, `scripts/e2e-nwc.ts` | `requireNwcEnv` and refusal tests |
| T10 | The agent (or a future LLM) sees P or a wallet secret | P never reaches the server before the meeting (only H does). Tool results never contain P or connection strings. | `web/src/api.ts`, `agent/tools.ts` | structure tests |
| T11 | Another web page drives the local server (CSRF, DNS rebinding) | Server binds to 127.0.0.1; Host header allow-list; POST must be `application/json` from our own origin; 16 KB body limit; strict CSP | `server/app.ts` | `tests/server/app.test.ts` |
| T12 | Malformed input | Every id matches `^[a-z0-9_]{1,40}$`, every hash or preimage is 32-byte hex, invoices are capped at 4 KB and fully decoded before use; errors never echo internals | `server/app.ts`, `ln/invoiceCheck.ts` | API tests |
| T13 | Simulator money confused with real money | SIMULATED banner on every screen and in the API; simulator invoices use the regtest prefix and a zero signature, so no real wallet can pay one; the `n`-tag payee shortcut is accepted only on regtest | `ln/sim.ts`, `ln/invoiceCheck.ts` | invoice tests |
| T14 | Supply chain | Exact version pins, lockfile from the public npm registry only, `npm install --ignore-scripts`, versions at least about two weeks old, `npm audit` clean at build time | `package.json`, `.npmrc` | - |

## Least privilege for real wallets

- Traveller's NWC connection: `pay_invoice` (plus `get_balance`, and `get_budget` if the wallet offers budgets). Set a wallet budget where the wallet supports one (NWC-13); then the wallet enforces the cap as well as the app.
- Guide's NWC connection: `make_hold_invoice`, `settle_hold_invoice`, `cancel_hold_invoice`, `lookup_invoice` only.
- Faucet test wallets come with fixed permissions that we cannot narrow; we say so in the demo.

## Known limits (honest list)

- Wallet-side budgets depend on the wallet. Without one, the app's mandate is the only cap.
- A hold can last only as long as the Lightning HTLC timeout allows, so funds are locked close to the tour (12 h assumed; to be measured on the first real run).
- After a tour is settled, a refund is a new payment that the guide starts (out of scope for v1).
- In this local demo all three views run on one machine; in production the traveller, the guide and the agent would each have their own device and authentication.
- If several test wallets live on one Lightning node, their invoices are signed by the same node key, so the payee check cannot tell them apart. Real guides on their own nodes or wallets do not have this problem.
- GDACS lists affected countries per event. A storm that passes close to Mauritius without being listed for it will not trigger the rule (GARANCE-25 in Feb 2025 was listed for Réunion only). A second feed (Mauritius Meteorological Services cyclone warnings) is planned.

## Reporting a problem

Please open a GitHub issue without exploit details, or contact the maintainers privately through the contact listed on the repository profile.
