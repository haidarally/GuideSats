// The simulator dressed as a real backend (simulated: false, kind "nwc"), so the NWC wiring, the API's
// NWC-mode controls and the e2e:nwc-app flows run offline. It counts the payer's pay calls.
import { SimBackend, SimLedger } from "../../src/ln/sim";
import type { LightningBackend, ReceiverWallet } from "../../src/ln/backend";

/** `receiverHook` can make the guide's wallet slow or lossy, like a busy shared wallet service. */
export function nonSimBackend(balances: Record<string, number>, clock: () => number = Date.now, receiverHook: (r: ReceiverWallet) => ReceiverWallet = (r) => r) {
  const ledger = new SimLedger({ clock, balances });
  const sim = new SimBackend(ledger);
  const pays: string[] = [];
  const backend: LightningBackend = {
    kind: "nwc",
    simulated: false,
    network: sim.network,
    payeeProof: sim.payeeProof,
    payer: (id) => {
      const p = sim.payer(id);
      return {
        ...p,
        payInvoice: (invoice) => {
          pays.push(invoice);
          return p.payInvoice(invoice);
        },
      };
    },
    receiver: (id) => receiverHook(sim.receiver(id)),
  };
  return { backend, ledger, pays };
}
