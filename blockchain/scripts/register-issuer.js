/**
 * Registers institutions on the issuer allowlist.
 *
 * Reads the deployed address from deployments/<network>.json, so no copy-paste.
 * Edit ISSUERS below, then:
 *
 *   npx hardhat run scripts/register-issuer.js --network amoy
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
  // { address: "0x…", name: "NIT Calicut — Registrar" },
  // { address: "0x…", name: "Sub-Registrar Office, Kozhikode" },
];

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

  if (ISSUERS.length === 0) {
    console.log("No issuers configured. Edit ISSUERS at the top of this script.");
    return;
  }

  console.log("registry:", address);
  for (const { address: issuer, name } of ISSUERS) {
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
