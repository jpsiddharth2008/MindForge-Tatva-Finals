/**
 * Registers institutions on the issuer allowlist.
 *
 * Reads the deployed address from deployments/<network>.json, so no copy-paste.
 *
 *   ISSUERS="0xAddr=Officer 1" \
 *     npx hardhat run scripts/register-issuer.js --network localhost
 *
 * Separate several with a semicolon. Taken from the environment rather than
 * edited into this file because the addresses differ per network: a local
 * Hardhat address hardcoded here would be committed and then be wrong on
 * Sepolia. ISSUERS below stays as a fallback for a fixed, long-lived list.
 *
 * IMPORTANT for the demo: keep one wallet OFF this list. Attempting to anchor
 * from it must revert with NotAuthorisedIssuer — that is the proof that a green
 * checkmark means "an authorised institution issued this", not merely
 * "somebody registered these bytes".
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ISSUERS = [
  // { address: "0x…", name: "Officer 1" },
  // { address: "0x…", name: "Sub-Registrar Office, Kozhikode" },
];

/** ISSUERS="0xabc…=Name One;0xdef…=Name Two" */
function fromEnv(raw) {
  return raw.split(";").map((entry) => {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error(`Malformed ISSUERS entry: "${entry}". Expected 0xAddress=Name`);
    const address = entry.slice(0, at).trim();
    const name = entry.slice(at + 1).trim();
    if (!hre.ethers.isAddress(address)) throw new Error(`Not an address: "${address}"`);
    if (!name) throw new Error(`Issuer ${address} needs a name; an empty name means "not authorised".`);
    return { address, name };
  });
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found for "${hre.network.name}". Run deploy.js first.`);
  }
  const { address } = JSON.parse(fs.readFileSync(file, "utf8"));

  const [admin] = await hre.ethers.getSigners();
  const registry = await hre.ethers.getContractAt("CredentialRegistry", address);

  const onChainAdmin = await registry.admin();
  if (onChainAdmin.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Signer ${admin.address} is not the contract admin (${onChainAdmin}). ` +
      `Use the deployer key.`
    );
  }

  const issuers = process.env.ISSUERS ? fromEnv(process.env.ISSUERS) : ISSUERS;
  if (issuers.length === 0) {
    console.log('No issuers configured. Set ISSUERS="0xAddress=Name" or edit ISSUERS at the top of this script.');
    return;
  }

  console.log("registry:", address);
  for (const { address: issuer, name } of issuers) {
    if (await registry.isIssuer(issuer)) {
      console.log("· already registered:", name);
      continue;
    }
    const tx = await registry.registerIssuer(issuer, name);
    await tx.wait();
    console.log("✅ registered:", name, "→", issuer);
  }

  console.log("\nVerify with:  await registry.isIssuer('0x…')");
}

main().catch((e) => {
  console.error("\n❌", e.message);
  process.exitCode = 1;
});
