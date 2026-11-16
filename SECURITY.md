# Security and threat model

GuideSats lets software (an AI agent) spend a traveller's sats. The whole design starts from one rule:
**the agent may only spend inside a mandate the traveller approved, and nothing the agent can reach can approve, widen or re-arm a mandate.**

Status: hackathon prototype. The money path is tested on a SIMULATED Lightning backend. The Nostr Wallet Connect adapter is unit-tested against a fake client. Over NWC, against Alby's NWC Faucet test wallets (dummy balances that exist only inside one Alby Hub), two things ran (see the README). The hold-invoice path ran on its own: lock and settle, lock and cancel. The app itself ran too, through `npm run demo:nwc` and `npm run e2e:nwc-app`: mandate, reconcile step, hold-limit check and cyclone rule, with one hold settled and one refunded on the synthetic cyclone replay. The re-approval after an expired hold invoice has run only on the simulator.

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
| T3 | The agent pays twice (retry, replay, race), or a payment lands under a booking that moved on | Single-use mandate reserved with an atomic compare-and-set **before** the first await; definite failures (only NIP-47 wallet refusals) re-arm it, unknown outcomes (timeouts, relay errors, anything unclassified) do not; the traveller cannot cancel while a payment is in flight; if the booking moved anyway, the accepted hold is cancelled at once; every booking transition after an await is a compare-and-set on its state; a late wallet reply changes the mandate only while the reservation is still its own (same hash), and a plan-B invoice request never repins the hash of a payment in flight | `app/payments.ts`, `app/service.ts`, `ln/nwc.ts`, `store/db.ts` | concurrent-payment test, `tests/app/races.test.ts`, `tests/app/stale-reply.test.ts`, `tests/ln/nwc.test.ts`, property test |
| T4 | The agent approves or raises its own mandate | No such tool exists. Tools get a closure-only facade with no handle on the store, the wallet or the approval function. Unknown tool names are refused. | `agent/tools.ts` | structure tests in `tests/agent/planner.test.ts` |
| T5 | The agent pays outside the agreed time | Mandate window from 50 min before the tour to its start ((24 blocks measured − 6 margin − 1 slack) × 10 min − 2 h meeting buffer); no hold invoice is made before the window opens | `domain/mandate.ts`, `domain/holdLimit.ts`, `app/service.ts` | mandate tests, `tests/app/lock-window.test.ts`, property test (clock jumps) |
| T6 | Money locked while a cyclone is coming | The cyclone rule is checked before every lock; an alert after the lock cancels the hold (automatic refund); an alert while a lock is in flight, or after an unknown outcome, cancels the hold invoice; one failing wallet call never stops the other refunds | `domain/cyclone.ts`, `app/service.ts` | recorded GDACS fixtures, service tests, `tests/app/races.test.ts` |
| T7 | The guide takes the money without showing up | Hold invoice: the guide can settle only with P, which the traveller shows at the meeting. If the hold is never settled it expires and the sats return. | `app/service.ts` (`settleWithPreimage`) | service tests |
| T8 | Secrets or PII leak into logs | Redacting logger: secret and PII keys removed whatever their value; NWC strings, emails, phone numbers and stray 64-hex values (preimages) scrubbed inside any string; invoices shortened. The audit table stores redacted fields only. | `log/redact.ts`, `store/db.ts` | snapshot test, audit test |
| T9 | Connection strings leak | Read only from env vars (`.env.example` has empty placeholders, `.env` is git-ignored); never logged; never echoed in errors; `.env` and the SDK are loaded only on the opt-in real paths (`demo:nwc`, `e2e:nwc`, `e2e:nwc-app`), which refuse to start without them; `npm run demo` stays SIMULATED even when `.env` exists | `ln/nwc.ts`, `server/nwcEnv.ts`, `server/main.ts`, `scripts/e2e-nwc.ts`, `scripts/e2e-nwc-app.ts` | `requireNwcEnv` and refusal tests for all three entry points |
| T10 | The agent (or a future LLM) sees P or a wallet secret | P never reaches the server before the meeting (only H does). Tool results never contain P or connection strings. | `web/src/api.ts`, `agent/tools.ts` | structure tests |
| T11 | Another web page drives the local server (CSRF, DNS rebinding) | Server binds to 127.0.0.1; Host header allow-list; POST must be `application/json` from our own origin; 16 KB body limit; strict CSP | `server/app.ts` | `tests/server/app.test.ts` |
| T12 | Malformed input | Every id matches `^[a-z0-9_]{1,40}$`, every hash or preimage is 32-byte hex, invoices are capped at 4 KB and fully decoded before use; errors never echo internals | `server/app.ts`, `ln/invoiceCheck.ts` | API tests |
| T13 | Simulator money confused with real money, or test wallets with real ones | SIMULATED banner on every screen and in the API; simulator invoices use the regtest prefix and a zero signature, so no real wallet can pay one; the `n`-tag payee shortcut is accepted only on regtest. Over NWC every screen names the backend ("NWC Faucet test wallets: dummy balances, no real sats") with its network and block height. That text is fixed and does not prove the wallets are test wallets: `.env` must only ever hold test wallets | `ln/sim.ts`, `ln/invoiceCheck.ts`, `web/src/main.tsx` | invoice tests, `tests/server/nwc-mode.test.ts` |
| T14 | Supply chain | Exact version pins, lockfile from the public npm registry only, `npm install --ignore-scripts`, versions at least about two weeks old, `npm audit` clean at build time | `package.json`, `.npmrc` | - |
| T15 | Plan B: paying for a tour that did not happen, or a swapped invoice | The agent may pay only after the traveller confirms the tour, only inside the post-tour window, and only the invoice the app itself asked the guide's wallet for (its hash is pinned on the booking) | `app/service.ts`, `app/payments.ts` | plan B service and API tests, property test |
| T16 | A payment whose outcome is unknown is decided wrongly, or twice (on the faucet wallets a cancelled hold made `pay_invoice` fail with `INTERNAL`) | One reconcile step looks the invoice up at the guide's wallet by hash, on the 30 s tick and right after the pay call: accepted → locked, settled → settled, cancelled or expired → released (an expired one is cancelled at the wallet first). Error text is never read. Every change is a compare-and-set on the mandate and the booking; plan B never re-arms on its own | `app/reconcile.ts`, `app/payments.ts`, `store/db.ts` | `tests/app/reconcile.test.ts`, `tests/scripts/e2e-nwc-flow.test.ts`, property test |
| T17 | An accepted hold outlives its wallet's limit, so the wallet cancels it before the meeting | The window comes from the measured 24-block limit with a 6-block margin. After every accept the app reads `settle_deadline` (a block height below 500 000 000, else unix seconds; 10 000 000 000 and above, most likely milliseconds, counts as none) and the wallet's block height; if the planned settle (tour start + 2 h) does not fit with 6 blocks to spare, the hold is cancelled at once (refund). No deadline, or no block height for a height deadline, counts as "does not fit" | `domain/holdLimit.ts`, `app/reconcile.ts` | `tests/domain/holdLimit.test.ts`, `tests/app/lock-window.test.ts`, e2e:sim scenario 6 |
| T18 | An old secret or an old hold invoice is replayed after a hold invoice expired | The expired invoice's H is retired (mandate back to the traveller, the old invoice cancelled at the guide's wallet); only the traveller re-approves, with a new secret; a hash used before is refused | `domain/mandate.ts`, `app/reconcile.ts`, `app/service.ts` | `tests/app/reapproval.test.ts` (replay test), API test, e2e:sim scenario 5, Playwright |
| T19 | A demo control fakes time or the chain on a real backend, a demo alert is taken for a real one, or the overspend demo reaches a wallet | On a non-simulated backend the API refuses (403) every control that fakes time or the chain (skip ahead, let an invoice expire) and reset, and the PWA hides them; the cyclone control stays only as a SYNTHETIC REPLAY of a recorded GDACS event, named so on every screen; the overspend push forges its invoices in the server (signed by a throwaway key with no node behind it), and the checks refuse them before any wallet call | `server/app.ts`, `web/src/Agent.tsx`, `ln/bolt11.ts` | `tests/server/nwc-mode.test.ts`, `tests/scripts/e2e-nwc-app-flow.test.ts` (the payer is never called for a forged invoice) |

## Least privilege for real wallets

- Traveller's NWC connection: `pay_invoice` (plus `get_balance`, and `get_budget` if the wallet offers budgets). Set a wallet budget where the wallet supports one (NWC-13); then the wallet enforces the cap as well as the app.
- Guide's NWC connection: `make_hold_invoice`, `settle_hold_invoice`, `cancel_hold_invoice`, `lookup_invoice` and `get_info` (for the block height) only.
- Faucet test wallets come with fixed permissions that we cannot narrow; we say so in the demo.

## Known limits (honest list)

- Wallet-side budgets depend on the wallet. Without one, the app's mandate is the only cap.
- A hold lasts only until the guide's wallet cancels it at its `settle_deadline`: on the faucet wallets a block height 24 blocks ahead, about 4 h (measured on 16 Nov 2026). Funds are therefore locked only from 50 min before the tour. Blocks arrive at random (on average one every 10 minutes); counting them as a Poisson process, a hold locked at the earliest moment survives a meeting on time with near certainty, a meeting 1 h late with a probability of about 99.9 %, and the very end of the 2 h buffer with about 94 %. When the wallet cancels first, the traveller is refunded; the guide is not paid.
- After a tour is settled, a refund is a new payment that the guide starts (out of scope for v1).
- In this local demo all three views run on one machine; in production the traveller, the guide and the agent would each have their own device and authentication.
- `demo:nwc` keeps its bookings in memory. On Ctrl+C (or SIGTERM) it cancels every hold it still has open at the guide's wallet before it exits; a crash would leave such a hold to the wallet's own settle deadline (about 4 h on the faucet wallets), after which the traveller is refunded.
- Wallet replies over NWC were sometimes missing (twice in the first two video takes on 16 Nov 2026, none after the app cut its own wallet reads); the cause is not established, and the faucet hub is shared with other users. A missing reply never moves money twice: unclear outcomes are left to the reconcile step, which reads the guide's wallet.
- The two faucet wallets report the same node key (they are sub-wallets of one Alby Hub), so the payee check cannot tell them apart and the faucet run does not exercise it. It is covered by unit and property tests with distinct keys. Real guides on their own nodes have distinct keys.
- In plan B, a payment whose outcome is unknown stays reserved until the guide's wallet reports the invoice settled, because a plain payment cannot be cancelled.
- GDACS lists affected countries per event. A storm that passes close to Mauritius without being listed for it will not trigger the rule (GARANCE-25 in Feb 2025 was listed for Réunion only). A second feed (Mauritius Meteorological Services cyclone warnings) is planned.

## Reporting a problem

Please open a GitHub issue without exploit details, or contact the maintainers privately through the contact listed on the repository profile.
