const { ethers } = require("hardhat");

/**
 * Deploy PolicyVault to the configured network.
 *
 * Policy parameters (edit before deploying):
 *   maxTransactionAmount = 0.1 ETH / 1 DEV (Moonbase)
 *   dailySpendingCap     = 0.5 ETH / 5 DEV (Moonbase)
 *
 * Run:
 *   npx hardhat run scripts/deploy.js --network moonbaseAlpha
 *   npx hardhat run scripts/deploy.js --network polkadotAssetHub
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`\n━━━ PolicyVault Deployment ━━━`);
  console.log(`Network:   ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:  ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH/DEV\n`);

  // ── Policy parameters ──────────────────────────────────────────────────────
  const maxTxAmount = ethers.parseEther("0.1");   // 0.1 DEV per transaction
  const dailyCap    = ethers.parseEther("0.5");   // 0.5 DEV per UTC day

  console.log(`maxTransactionAmount: ${ethers.formatEther(maxTxAmount)} ETH/DEV`);
  console.log(`dailySpendingCap:     ${ethers.formatEther(dailyCap)} ETH/DEV\n`);

  // ── Deploy ─────────────────────────────────────────────────────────────────
  console.log("Deploying PolicyVault...");
  const PolicyVault = await ethers.getContractFactory("PolicyVault");
  const vault = await PolicyVault.deploy(maxTxAmount, dailyCap);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const deployTx = vault.deploymentTransaction();

  console.log(`✅ PolicyVault deployed at: ${address}`);
  console.log(`   TX hash: ${deployTx?.hash}`);
  console.log(`   Block:   ${deployTx?.blockNumber ?? "pending"}`);

  // ── Fund the vault (optional, for demo) ───────────────────────────────────
  if (process.env.FUND_VAULT === "true") {
    const fundAmount = ethers.parseEther("0.2");
    console.log(`\nFunding vault with ${ethers.formatEther(fundAmount)} ETH/DEV...`);
    const fundTx = await deployer.sendTransaction({ to: address, value: fundAmount });
    await fundTx.wait();
    console.log(`✅ Vault funded. Balance: ${ethers.formatEther(await vault.getBalance())} ETH/DEV`);
  }

  // ── Verify summary ─────────────────────────────────────────────────────────
  console.log(`\n━━━ Deployment Summary ━━━`);
  console.log(`Contract:            PolicyVault`);
  console.log(`Address:             ${address}`);
  console.log(`Owner:               ${await vault.owner()}`);
  console.log(`maxTransactionAmount: ${ethers.formatEther(await vault.maxTransactionAmount())} ETH/DEV`);
  console.log(`dailySpendingCap:    ${ethers.formatEther(await vault.dailySpendingCap())} ETH/DEV`);
  console.log(`Vault balance:       ${ethers.formatEther(await vault.getBalance())} ETH/DEV`);

  // Explorer links
  const explorers = {
    1287n:      `https://moonbase.moonscan.io/address/${address}`,
    420420422n: `https://blockscout-asset-hub.parity-testnet.parity.io/address/${address}`,
  };
  if (explorers[network.chainId]) {
    console.log(`\nExplorer: ${explorers[network.chainId]}`);
  }

  // Write deployment info for frontend
  const fs = require("fs");
  const deployInfo = {
    network:   network.name,
    chainId:   network.chainId.toString(),
    address:   address,
    deployer:  deployer.address,
    timestamp: new Date().toISOString(),
    maxTransactionAmount: maxTxAmount.toString(),
    dailySpendingCap: dailyCap.toString(),
    txHash:    deployTx?.hash,
  };
  fs.writeFileSync("deployment.json", JSON.stringify(deployInfo, null, 2));
  console.log(`\nDeployment info saved to deployment.json`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
