/**
 * Deploys CredentialRegistry and writes the deployment record + ABI to disk
 * so the backend can consume them without copy-pasting addresses.
 *
 *   npx hardhat run scripts/deploy.js --network amoy
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n─── MindForge · CredentialRegistry ───");
  console.log("network :", hre.network.name, `(chainId ${net.chainId})`);
  console.log("deployer:", deployer.address);
  console.log("balance :", hre.ethers.formatEther(balance), "\n");

  if (balance === 0n) {
    throw new Error(
      "Deployer has zero balance. Fund it from a faucet before deploying.\n" +
      "  Amoy:    https://faucet.polygon.technology\n" +
      "  Sepolia: https://sepoliafaucet.com"
    );
  }

  const factory = await hre.ethers.getContractFactory("CredentialRegistry");
  const registry = await factory.deploy();
  console.log("tx sent, waiting for confirmation…");
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  const txHash = registry.deploymentTransaction().hash;
  console.log("✅ deployed at", address);

  // Wait for a few confirmations before attempting source verification,
  // otherwise the explorer has not indexed the contract yet.
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("waiting 5 confirmations before verification…");
    await registry.deploymentTransaction().wait(5);
  }

  // ---- persist deployment record -----------------------------------------
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const record = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    address,
    deployer: deployer.address,
    txHash,
    deployedAt: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(outDir, `${hre.network.name}.json`),
    JSON.stringify(record, null, 2)
  );

  // ---- export ABI for the backend ----------------------------------------
  const artifact = await hre.artifacts.readArtifact("CredentialRegistry");
  const abiDir = path.join(__dirname, "..", "abi");
  fs.mkdirSync(abiDir, { recursive: true });
  fs.writeFileSync(
    path.join(abiDir, "CredentialRegistry.json"),
    JSON.stringify(artifact.abi, null, 2)
  );

  console.log("\nWrote deployments/%s.json and abi/CredentialRegistry.json", hre.network.name);
  console.log("\nAdd to backend/.env:");
  console.log("  CONTRACT_ADDRESS=%s", address);
  console.log("  POLYGON_CHAIN_ID=%s", net.chainId);

  // ---- verify source on the explorer -------------------------------------
  if (hre.network.name === "amoy" || hre.network.name === "sepolia") {
    try {
      await hre.run("verify:verify", { address, constructorArguments: [] });
      console.log("✅ source verified on explorer");
    } catch (e) {
      console.log("⚠️  verification skipped:", e.message.split("\n")[0]);
      console.log("   retry: npx hardhat verify --network %s %s", hre.network.name, address);
    }
  }

  console.log("\nNext: register issuers →  npx hardhat run scripts/register-issuer.js --network %s\n", hre.network.name);
}

main().catch((e) => {
  console.error("\n❌ deploy failed:", e.message);
  process.exitCode = 1;
});
