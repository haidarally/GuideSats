# 3-minute demo video: script

The event asks for "problem → solution → impact → next steps". The app footage is two clips that `npm run record:nwc` records at phone size (412 × 916 at 2x), over NWC against Alby's NWC Faucet test wallets: dummy balances inside one Alby Hub. Every frame shows the banner "NWC Faucet test wallets: dummy balances, no real sats". Say so in a caption too. If any simulator footage is used instead, it shows SIMULATED, and the video must say so.

- **Clip 1, flow (a), about 50 s:** book, the mandate, approve, the agent locks 42 sats, the meeting code, the guide settles and is paid.
- **Clip 2, flow (b), about 41 s:** a second booking, the overspend push refused, the agent locks 21 sats, the synthetic cyclone replay, the refund.

Clip times below are seconds from the start of each clip (the step marks the recording writes, within about half a second).

| Video time | Screen | Voice-over / caption |
|---|---|---|
| 0:00 to 0:25 | Le Morne photo or map; then clip 1, 0:00 to 0:06 (the app opens: NWC Faucet banner, balance, tours) | **Problem.** "In Mauritius, small guides lose the day when a booked guest doesn't show. Travellers lose deposits when a cyclone cancels the tour. And now AI agents book trips: who controls what they spend? This is GuideSats, over Nostr Wallet Connect on Alby's NWC Faucet test wallets: dummy balances, no real sats." |
| 0:25 to 0:39 | Clip 1, 0:06 to 0:20: the mandate card (cap 42 sats, the guide's key, the window, one payment), then **Approve mandate** | **The mandate.** "The traveller books the Le Morne hike. The mandate: 42 sats maximum, only this guide's key, only in this window, one payment. Only the traveller can approve it. The phone keeps a secret and sends only its hash." |
| 0:39 to 0:52 | Clip 1, 0:20 to 0:34: the agent console (request_invoice, pay_invoice, locked), then the card "Sats locked in a hold invoice" and the meeting code | **Locked, not sent.** "The agent asks the guide's wallet for a hold invoice. It checks the amount, the hash, the network, the expiry and the payee from the signature, then pays. The sats are now locked, not sent. The phone shows the meeting code." |
| 0:52 to 1:08 | Clip 1, 0:34 to 0:50: the Guide tab, the code entered, **Settle**, "Paid to the guide", guide balance +42; the traveller's balance −42 | **Meeting.** "At the meeting point the guide enters the code and settles. The guide's wallet receives 42 sats, the booking says paid, and the traveller's balance is down by exactly the price." |
| 1:08 to 1:29 | Clip 2, 0:00 to 0:21: the second booking (21 sats), approved; Agent tab, **Push the agent to overspend**, four refusals in the console | **Security.** "A second booking: 21 sats, approved. Now we push the agent. Three times the price; the right price, signed by another key; approving its own mandate; raising the cap. All four are refused before any wallet is called. A property test throws thousands of random tool calls at it, and the ledger never moves outside the mandate." |
| 1:29 to 1:49 | Clip 2, 0:21 to 0:41: the real lock goes through; **Trigger GDACS cyclone alert (SYNTHETIC REPLAY of BELAL-24)**; the red banner; "Refunded: cyclone alert", the balance back | **Cyclone.** "The real lock goes through. Then GDACS, the UN and EU disaster alert system, reports cyclone Belal near Mauritius. This is a synthetic replay of the real January 2024 record. The hold is cancelled and the traveller's 21 sats come back. No one had to ask." |
| 1:49 to 2:15 | README "Next iteration"; the **Pay after the tour** button on a tour card (in both clips) | **Impact and next.** "A pilot target is 20 guides, about 100 bookings a week. For wallets without hold invoices, the same mandate pays after the tour, once the traveller confirms it. Next: two separate nodes, wallet-enforced budgets, a Mauritius Meteorological Services feed, and a Kreol interface. The code is open source, MIT." |

The whole video runs about 2:15, under the 3-minute limit.

Checklist before recording:

- [ ] `.env` holds the two NWC Faucet test wallets. The traveller has at least 2 000 sats; `record:nwc` checks this and refuses otherwise.
- [ ] `npm run record:nwc` (Playwright; set `PW_EXECUTABLE_PATH` for an installed Chromium). It starts `demo:nwc` itself and stops it with SIGTERM, so no hold stays open. `RECORD_BACKEND=sim` records a dry run on the simulator.
- [ ] The videos are in `test-results/record/*/video.webm`, with the step times in `marks.json`. Keep them out of the repo.
- [ ] Check the frames: the NWC Faucet banner is visible, there is no error banner, and nothing shows a `.env` file, a connection string or a local path. The meeting codes on screen belong to holds that were settled or cancelled in the take, so they can no longer move sats.
- [ ] Captions: "Over NWC against Alby's NWC Faucet test wallets (dummy balances inside one Alby Hub)", and "SYNTHETIC REPLAY" on the cyclone shot.
