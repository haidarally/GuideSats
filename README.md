# GuideSats (working name)

An AI travel agent books and pays a small Mauritian tour guide in sats over Lightning.
It can only spend inside a **mandate the traveller approves** (amount cap, guide's key, time window, one use).
The money waits in a **hold invoice**; if a GDACS cyclone alert hits Mauritius before the tour, the hold is cancelled and the traveller is refunded automatically.

> Status: work in progress for the Dakar Bitcoin Hack 2026. The full README is written at the end of the build; see `PROGRESS.md`.

## Run

```bash
npm install
npm run demo      # http://127.0.0.1:8787 , SIMULATED Lightning, seed data
```

## Test

```bash
npm run check     # typecheck + all tests, offline, no keys
```

License: MIT.
