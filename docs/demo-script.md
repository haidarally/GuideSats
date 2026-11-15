# 3-minute demo video: script

The event asks for "problem → solution → impact → next steps". Record at phone width (412 px), screen only, with captions. If the real NWC run has passed, show its terminal output in part 3; otherwise the video must say "SIMULATED" whenever the simulator is on screen.

| Time | Screen | Voice-over / caption |
|---|---|---|
| 0:00 to 0:25 | Le Morne photo or map; then the empty app | **Problem.** "In Mauritius, small guides lose the day when a booked guest doesn't show. Travellers lose deposits when a cyclone cancels the tour. And now AI agents book trips: who controls what they spend?" |
| 0:25 to 0:50 | Traveller wallet → Book → mandate card | **The mandate.** "The agent proposes the Le Morne hike. The traveller sees a mandate: 21 000 sats maximum, only this guide's key, only in this window, one payment. Only the traveller can approve it, and the agent has no tool to change it." |
| 0:50 to 1:20 | Approve → Ask the agent → agent console | **Locked, not sent.** "The phone makes a secret and sends only its hash. The agent asks the guide's wallet for a hold invoice, and our code decodes and checks it (amount, hash, network, expiry, and the payee from the signature) before paying. The sats are now locked." |
| 1:20 to 1:45 | Meeting code → Guide tab → Settle → balance | **Meeting.** "At the meeting point the traveller shows the code. The guide settles and is paid 21 000 sats, instantly, to their own wallet." |
| 1:45 to 2:15 | New booking → lock → Agent tab → cyclone alert → refund | **Cyclone.** "Another booking is locked. GDACS, the UN and EU disaster alert system, reports cyclone Belal near Mauritius: this is a replay of the real January 2024 record. The hold is cancelled and the traveller is refunded automatically. No one had to ask." |
| 2:15 to 2:35 | `npm run e2e:sim` section 3, or the property test output | **Security.** "We tried to make the agent pay more, or pay someone else, or pay twice: a property test throws thousands of random tool calls at it. The ledger never moves outside the mandate." |
| 2:35 to 3:00 | README "next iteration" | **Impact and next.** "A pilot target is 20 guides, about 100 bookings a week. Next: the meeting code as a QR code, a pay-on-completion path for wallets without holds, and a Mauritius Meteorological Services feed. The code is open source, MIT." |

Checklist before recording:

- [ ] `npm run demo` from a fresh clone; then click **Reset demo**.
- [ ] Browser at 412 × 860; language EN (record a French take if time allows).
- [ ] The SIMULATED banner is visible whenever the simulator is used.
- [ ] No terminal shows a `.env` file or a connection string.
