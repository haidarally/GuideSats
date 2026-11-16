# 3-minute demo video: script

The event asks for "problem → solution → impact → next steps". Record at phone width (412 px), screen only, with captions. The video must say "SIMULATED" whenever the simulator is on screen. Part 3 may show the `npm run e2e:nwc` output; if it does, say on screen that it ran over NWC against Alby's NWC Faucet test wallets (dummy balances inside one Alby Hub).

| Time | Screen | Voice-over / caption |
|---|---|---|
| 0:00 to 0:25 | Le Morne photo or map; then the empty app | **Problem.** "In Mauritius, small guides lose the day when a booked guest doesn't show. Travellers lose deposits when a cyclone cancels the tour. And now AI agents book trips: who controls what they spend?" |
| 0:25 to 0:50 | Traveller wallet → Book → mandate card | **The mandate.** "The agent proposes the Le Morne hike. The traveller sees a mandate: 21 000 sats maximum, only this guide's key, only in this window, one payment. Only the traveller can approve it, and the agent has no tool to change it." |
| 0:50 to 1:20 | Approve → Ask the agent → agent console | **Locked, not sent.** "The phone makes a secret and sends only its hash. The agent asks the guide's wallet for a hold invoice, and our code decodes and checks it (amount, hash, network, expiry, and on real wallets the payee recovered from the signature) before paying. The sats are now locked." |
| 1:20 to 1:45 | Meeting code → Guide tab → Settle → balance | **Meeting.** "At the meeting point the traveller shows the code. The guide settles and is paid 21 000 sats, instantly, to their own wallet." |
| 1:45 to 2:15 | New booking → lock → Agent tab → cyclone alert → refund | **Cyclone.** "Another booking is locked. GDACS, the UN and EU disaster alert system, reports cyclone Belal near Mauritius: this is a replay of the real January 2024 record. The hold is cancelled and the traveller is refunded automatically. No one had to ask." |
| 2:15 to 2:35 | Agent tab → **Push the agent to overspend** → four refusals in the console | **Security.** "Now we push the agent: three times the price, the right price to another guide, approving its own mandate, raising the cap. All refused. A property test throws thousands of random tool calls at it, and the ledger never moves outside the mandate." |
| 2:35 to 3:00 | README "next iteration"; a glimpse of **Pay after the tour** | **Impact and next.** "A pilot target is 20 guides, about 100 bookings a week. For wallets without hold invoices, the same mandate pays after the tour, once the traveller confirms it. Next: wallet-enforced budgets, a Mauritius Meteorological Services feed, and a Kreol interface. The code is open source, MIT." |

Checklist before recording:

- [ ] `npm run demo` from a fresh clone; then click **Reset demo**.
- [ ] Browser at 412 × 860; language EN (record a French take if time allows).
- [ ] The SIMULATED banner is visible whenever the simulator is used.
- [ ] No terminal shows a `.env` file or a connection string.
