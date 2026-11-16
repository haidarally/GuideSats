// The opt-in NWC path: refuse to start unless .env holds NWC_TRAVELLER_URL, NWC_GUIDE_URL and NWC_NETWORK.
// Values are loaded into process.env and never printed; the refusal names missing keys only.
import { existsSync } from "node:fs";

export const NWC_REQUIRED = ["NWC_TRAVELLER_URL", "NWC_GUIDE_URL", "NWC_NETWORK"] as const;

export function loadNwcEnvOrExit(name: string): void {
  const refuse = (msg: string): never => {
    process.stderr.write(`${name} refused: ${msg}\nCopy .env.example to .env and fill the values for two TEST wallets (never commit .env).\n`);
    process.exit(2);
  };
  if (!existsSync(".env")) refuse("no .env file in the repo root");
  try {
    process.loadEnvFile(".env");
  } catch {
    refuse(".env could not be read");
  }
  const missing = NWC_REQUIRED.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length > 0) refuse(`missing values: ${missing.join(", ")}`);
}
