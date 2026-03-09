const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Decision enum values (must match contract)
const Decision = { APPROVE: 0n, REJECT: 1n, ESCALATE: 2n };

const ONE_ETH   = ethers.parseEther("1.0");
const HALF_ETH  = ethers.parseEther("0.5");
const ONE_GWEI  = ethers.parseUnits("1", "gwei");

/**
 * Shared fixture: deploy PolicyVault with:
 *   maxTxAmount = 1 ETH
 *   dailyCap    = 3 ETH
 * and fund the vault with 10 ETH.
 */
async function deployFixture() {
  const [owner, agent, approver, recipient, blacklistedAddr, stranger] = await ethers.getSigners();

  const PolicyVault = await ethers.getContractFactory("PolicyVault");
  const vault = await PolicyVault.deploy(
    ONE_ETH,                   // maxTransactionAmount
    ethers.parseEther("3.0")   // dailySpendingCap
  );
  await vault.waitForDeployment();

  // Fund the vault
  await owner.sendTransaction({ to: vault.target, value: ethers.parseEther("10.0") });

  // Set up roles
  await vault.grantAgent(agent.address);
  await vault.grantApprover(approver.address);

  return { vault, owner, agent, approver, recipient, blacklistedAddr, stranger };
}

// ============================================================================
// DEPLOYMENT
// ============================================================================
describe("PolicyVault — Deployment", function () {
  it("sets owner correctly", async function () {
    const { vault, owner } = await loadFixture(deployFixture);
    expect(await vault.owner()).to.equal(owner.address);
  });

  it("stores policy parameters", async function () {
    const { vault } = await loadFixture(deployFixture);
    expect(await vault.maxTransactionAmount()).to.equal(ONE_ETH);
    expect(await vault.dailySpendingCap()).to.equal(ethers.parseEther("3.0"));
  });

  it("grants owner agent + approver roles by default", async function () {
    const { vault, owner } = await loadFixture(deployFixture);
    expect(await vault.agents(owner.address)).to.be.true;
    expect(await vault.approvers(owner.address)).to.be.true;
  });

  it("initialises lastResetDay to today UTC", async function () {
    const { vault } = await loadFixture(deployFixture);
    const now = await time.latest();
    const today = BigInt(now) / 86400n;
    expect(await vault.lastResetDay()).to.equal(today);
  });

  it("receives ETH and emits Deposited", async function () {
    const { vault, stranger } = await loadFixture(deployFixture);
    await expect(stranger.sendTransaction({ to: vault.target, value: ONE_GWEI }))
      .to.emit(vault, "Deposited")
      .withArgs(stranger.address, ONE_GWEI);
  });

  it("deposit() emits Deposited", async function () {
    const { vault, stranger } = await loadFixture(deployFixture);
    await expect(vault.connect(stranger).deposit({ value: ONE_GWEI }))
      .to.emit(vault, "Deposited");
  });

  it("reverts if maxTxAmount is 0", async function () {
    const PolicyVault = await ethers.getContractFactory("PolicyVault");
    await expect(PolicyVault.deploy(0n, ONE_ETH))
      .to.be.revertedWith("PolicyVault: maxTxAmount must be > 0");
  });

  it("reverts if dailyCap < maxTxAmount", async function () {
    const PolicyVault = await ethers.getContractFactory("PolicyVault");
    await expect(PolicyVault.deploy(ONE_ETH, HALF_ETH))
      .to.be.revertedWith("PolicyVault: dailyCap must be >= maxTxAmount");
  });

  it("getBalance returns vault ETH balance", async function () {
    const { vault } = await loadFixture(deployFixture);
    expect(await vault.getBalance()).to.equal(ethers.parseEther("10.0"));
  });
});

// ============================================================================
// ROLE MANAGEMENT
// ============================================================================
describe("PolicyVault — Role Management", function () {
  it("grants agent role", async function () {
    const { vault, stranger } = await loadFixture(deployFixture);
    await vault.grantAgent(stranger.address);
    expect(await vault.agents(stranger.address)).to.be.true;
  });

  it("revokes agent role", async function () {
    const { vault, agent } = await loadFixture(deployFixture);
    await vault.revokeAgent(agent.address);
    expect(await vault.agents(agent.address)).to.be.false;
  });

  it("grants approver role", async function () {
    const { vault, stranger } = await loadFixture(deployFixture);
    await vault.grantApprover(stranger.address);
    expect(await vault.approvers(stranger.address)).to.be.true;
  });

  it("revokes approver role", async function () {
    const { vault, approver } = await loadFixture(deployFixture);
    await vault.revokeApprover(approver.address);
    expect(await vault.approvers(approver.address)).to.be.false;
  });

  it("only owner can grant agent", async function () {
    const { vault, stranger, agent } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).grantAgent(stranger.address))
      .to.be.revertedWith("PolicyVault: caller is not owner");
  });

  it("only owner can grant approver", async function () {
    const { vault, stranger, agent } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).grantApprover(stranger.address))
      .to.be.revertedWith("PolicyVault: caller is not owner");
  });

  it("grantAgent reverts on zero address", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.grantAgent(ethers.ZeroAddress))
      .to.be.revertedWith("PolicyVault: invalid address");
  });

  it("grantApprover reverts on zero address", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.grantApprover(ethers.ZeroAddress))
      .to.be.revertedWith("PolicyVault: invalid address");
  });

  it("transfers ownership", async function () {
    const { vault, owner, stranger } = await loadFixture(deployFixture);
    await expect(vault.transferOwnership(stranger.address))
      .to.emit(vault, "OwnershipTransferred")
      .withArgs(owner.address, stranger.address);
    expect(await vault.owner()).to.equal(stranger.address);
  });

  it("transferOwnership reverts on zero address", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWith("PolicyVault: invalid address");
  });

  it("only owner can transfer ownership", async function () {
    const { vault, agent, stranger } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).transferOwnership(stranger.address))
      .to.be.revertedWith("PolicyVault: caller is not owner");
  });
});

// ============================================================================
// POLICY CONFIGURATION
// ============================================================================
describe("PolicyVault — Policy Configuration", function () {
  it("owner can update maxTransactionAmount", async function () {
    const { vault } = await loadFixture(deployFixture);
    const newLimit = ethers.parseEther("2.0");
    await expect(vault.setMaxTransactionAmount(newLimit))
      .to.emit(vault, "PolicyUpdated")
      .withArgs("maxTransactionAmount", newLimit, await (await ethers.getSigners())[0].getAddress());
    expect(await vault.maxTransactionAmount()).to.equal(newLimit);
  });

  it("reverts if new maxTxAmount is 0", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.setMaxTransactionAmount(0n))
      .to.be.revertedWith("PolicyVault: must be > 0");
  });

  it("owner can update dailySpendingCap", async function () {
    const { vault } = await loadFixture(deployFixture);
    const newCap = ethers.parseEther("5.0");
    await expect(vault.setDailySpendingCap(newCap))
      .to.emit(vault, "PolicyUpdated")
      .withArgs("dailySpendingCap", newCap, await (await ethers.getSigners())[0].getAddress());
    expect(await vault.dailySpendingCap()).to.equal(newCap);
  });

  it("reverts if dailyCap < maxTxAmount", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.setDailySpendingCap(HALF_ETH))
      .to.be.revertedWith("PolicyVault: cap must be >= maxTxAmount");
  });

  it("non-owner cannot update policy", async function () {
    const { vault, agent } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).setMaxTransactionAmount(ONE_ETH))
      .to.be.revertedWith("PolicyVault: caller is not owner");
  });
});

// ============================================================================
// BLACKLIST
// ============================================================================
describe("PolicyVault — Blacklist", function () {
  it("owner can blacklist an address", async function () {
    const { vault, blacklistedAddr, owner } = await loadFixture(deployFixture);
    await expect(vault.setBlacklisted(blacklistedAddr.address, true))
      .to.emit(vault, "BlacklistUpdated")
      .withArgs(blacklistedAddr.address, true, owner.address);
    expect(await vault.blacklisted(blacklistedAddr.address)).to.be.true;
  });

  it("owner can remove from blacklist", async function () {
    const { vault, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);
    await vault.setBlacklisted(blacklistedAddr.address, false);
    expect(await vault.blacklisted(blacklistedAddr.address)).to.be.false;
  });

  it("setBlacklisted reverts on zero address", async function () {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.setBlacklisted(ethers.ZeroAddress, true))
      .to.be.revertedWith("PolicyVault: invalid address");
  });

  it("non-owner cannot blacklist", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).setBlacklisted(blacklistedAddr.address, true))
      .to.be.revertedWith("PolicyVault: caller is not owner");
  });
});

// ============================================================================
// POLICY ENGINE — checkPolicy view
// ============================================================================
describe("PolicyVault — checkPolicy (view)", function () {
  it("returns APPROVE for normal amounts", async function () {
    const { vault, recipient } = await loadFixture(deployFixture);
    const [dec, reason] = await vault.checkPolicy(recipient.address, HALF_ETH);
    expect(dec).to.equal(Decision.APPROVE);
    expect(reason).to.equal("Within policy limits");
  });

  it("returns REJECT for blacklisted address", async function () {
    const { vault, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);
    const [dec, reason] = await vault.checkPolicy(blacklistedAddr.address, ONE_GWEI);
    expect(dec).to.equal(Decision.REJECT);
    expect(reason).to.equal("Recipient is blacklisted");
  });

  it("returns ESCALATE when amount > maxTxAmount", async function () {
    const { vault, recipient } = await loadFixture(deployFixture);
    const [dec, reason] = await vault.checkPolicy(recipient.address, ethers.parseEther("1.1"));
    expect(dec).to.equal(Decision.ESCALATE);
    expect(reason).to.equal("Amount exceeds per-transaction limit");
  });

  it("returns ESCALATE when would exceed daily cap", async function () {
    const { vault, recipient, agent } = await loadFixture(deployFixture);
    // Spend 2.5 ETH of the 3 ETH daily cap
    await vault.connect(agent).propose(recipient.address, ethers.parseEther("1.0"), "0x", "tx1");
    await vault.connect(agent).propose(recipient.address, ethers.parseEther("1.0"), "0x", "tx2");
    await vault.connect(agent).propose(recipient.address, HALF_ETH, "0x", "tx3");
    // Now checking 0.6 ETH should ESCALATE
    const [dec, reason] = await vault.checkPolicy(recipient.address, ethers.parseEther("0.6"));
    expect(dec).to.equal(Decision.ESCALATE);
    expect(reason).to.equal("Would exceed daily spending cap");
  });

  it("remainingDailyBudget reflects spent amounts", async function () {
    const { vault, recipient, agent } = await loadFixture(deployFixture);
    const before = await vault.remainingDailyBudget();
    expect(before).to.equal(ethers.parseEther("3.0"));

    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "tx");
    const after = await vault.remainingDailyBudget();
    expect(after).to.equal(ethers.parseEther("2.0"));
  });
});

// ============================================================================
// PROPOSE — APPROVE PATH
// ============================================================================
describe("PolicyVault — propose: APPROVE path", function () {
  it("auto-executes approved transactions", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const before = await ethers.provider.getBalance(recipient.address);
    const tx = await vault.connect(agent).propose(recipient.address, HALF_ETH, "0x", "payment");
    const receipt = await tx.wait();

    // Check events
    const iface = vault.interface;
    const proposed = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "TxProposed");
    const decision = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "PolicyDecision");
    const executed = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "TxExecuted");

    expect(proposed).to.not.be.null;
    expect(decision.args.decision).to.equal(Decision.APPROVE);
    expect(executed).to.not.be.null;

    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(HALF_ETH);
  });

  it("increments dailySpent after approval", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    await vault.connect(agent).propose(recipient.address, HALF_ETH, "0x", "p");
    expect(await vault.dailySpent()).to.equal(HALF_ETH);
  });

  it("assigns sequential txIds starting at 0", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const tx1 = await vault.connect(agent).propose(recipient.address, ONE_GWEI, "0x", "p1");
    const r1 = await tx1.wait();
    const tx2 = await vault.connect(agent).propose(recipient.address, ONE_GWEI, "0x", "p2");
    const r2 = await tx2.wait();

    const getProposedId = (receipt) =>
      vault.interface.parseLog(receipt.logs.find(l => {
        try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; }
      }))?.args.txId;

    expect(getProposedId(r1)).to.equal(0n);
    expect(getProposedId(r2)).to.equal(1n);
  });

  it("owner can also propose (owner is agent)", async function () {
    const { vault, owner, recipient } = await loadFixture(deployFixture);
    await expect(vault.connect(owner).propose(recipient.address, ONE_GWEI, "0x", "p"))
      .to.emit(vault, "TxExecuted");
  });

  it("forwards calldata on execution", async function () {
    const { vault, agent } = await loadFixture(deployFixture);

    // Deploy a simple receiver contract that records calls
    const Receiver = await ethers.getContractFactory("TestReceiver");
    const receiver = await Receiver.deploy();
    await receiver.waitForDeployment();

    // Fund vault more for this test
    const [owner] = await ethers.getSigners();
    await owner.sendTransaction({ to: vault.target, value: ONE_ETH });

    const calldata = receiver.interface.encodeFunctionData("ping");
    // Send 1 wei alongside the calldata — valid ETH+calldata forward
    await vault.connect(agent).propose(receiver.target, 1n, calldata, "ping");
    expect(await receiver.pinged()).to.be.true;
  });
});

// ============================================================================
// PROPOSE — REJECT PATH
// ============================================================================
describe("PolicyVault — propose: REJECT path", function () {
  it("rejects blacklisted recipients", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);

    const tx = await vault.connect(agent).propose(blacklistedAddr.address, ONE_GWEI, "0x", "bad");
    const receipt = await tx.wait();

    const iface = vault.interface;
    const decisionLog = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "PolicyDecision");
    const rejectedLog = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "TxRejected");

    expect(decisionLog.args.decision).to.equal(Decision.REJECT);
    expect(rejectedLog).to.not.be.null;
  });

  it("does not transfer funds on rejection", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);
    const before = await vault.getBalance();
    await vault.connect(agent).propose(blacklistedAddr.address, ONE_GWEI, "0x", "bad");
    const after = await vault.getBalance();
    expect(after).to.equal(before);
  });

  it("marks rejected tx as cancelled", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);
    const tx = await vault.connect(agent).propose(blacklistedAddr.address, ONE_GWEI, "0x", "bad");
    const receipt = await tx.wait();
    const txId = vault.interface.parseLog(
      receipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;

    const [, , , , , executed, cancelled] = await vault.getPendingTx(txId);
    expect(executed).to.be.false;
    expect(cancelled).to.be.true;
  });

  it("does not increment dailySpent on rejection", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);
    await vault.connect(agent).propose(blacklistedAddr.address, ONE_GWEI, "0x", "bad");
    expect(await vault.dailySpent()).to.equal(0n);
  });
});

// ============================================================================
// PROPOSE — ESCALATE PATH
// ============================================================================
describe("PolicyVault — propose: ESCALATE path", function () {
  it("escalates when amount exceeds per-tx limit", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const bigAmount = ethers.parseEther("1.5");
    const tx = await vault.connect(agent).propose(recipient.address, bigAmount, "0x", "big");
    const receipt = await tx.wait();

    const iface = vault.interface;
    const decisionLog = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "PolicyDecision");

    expect(decisionLog.args.decision).to.equal(Decision.ESCALATE);
    expect(decisionLog.args.reason).to.equal("Amount exceeds per-transaction limit");
  });

  it("escalates when would exceed daily cap", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    // Spend up to daily cap boundary: 3 × 1 ETH = 3 ETH cap
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t1");
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t2");
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t3");

    // Next one should escalate (would bring daily to 4 ETH > 3 ETH cap)
    const tx = await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t4");
    const receipt = await tx.wait();
    const iface = vault.interface;
    const decisionLog = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "PolicyDecision");

    expect(decisionLog.args.decision).to.equal(Decision.ESCALATE);
    expect(decisionLog.args.reason).to.equal("Would exceed daily spending cap");
  });

  it("leaves ESCALATE tx as not-executed, not-cancelled", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const tx = await vault.connect(agent).propose(recipient.address, ethers.parseEther("2.0"), "0x", "big");
    const receipt = await tx.wait();
    const txId = vault.interface.parseLog(
      receipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;

    const [, , , , , executed, cancelled] = await vault.getPendingTx(txId);
    expect(executed).to.be.false;
    expect(cancelled).to.be.false;
  });

  it("stores full tx details in pending queue", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("2.0");
    const desc = "big payment for infrastructure";
    const tx = await vault.connect(agent).propose(recipient.address, amount, "0x", desc);
    const receipt = await tx.wait();
    const txId = vault.interface.parseLog(
      receipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;

    const [to, storedAmount, storedDesc, , proposedBy, , ] = await vault.getPendingTx(txId);
    expect(to).to.equal(recipient.address);
    expect(storedAmount).to.equal(amount);
    expect(storedDesc).to.equal(desc);
    expect(proposedBy).to.equal(agent.address);
  });
});

// ============================================================================
// APPROVER ACTIONS
// ============================================================================
describe("PolicyVault — Approver Actions", function () {
  async function escalatedFixture() {
    const base = await loadFixture(deployFixture);
    const { vault, agent, recipient } = base;
    const bigAmount = ethers.parseEther("2.0");
    const tx = await vault.connect(agent).propose(recipient.address, bigAmount, "0x", "big");
    const receipt = await tx.wait();
    const txId = vault.interface.parseLog(
      receipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;
    return { ...base, txId, bigAmount };
  }

  it("approver can approve a queued transaction", async function () {
    const { vault, approver, recipient, txId, bigAmount } = await escalatedFixture();
    const before = await ethers.provider.getBalance(recipient.address);

    await expect(vault.connect(approver).approveTx(txId))
      .to.emit(vault, "TxApproved")
      .withArgs(txId, approver.address);

    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(bigAmount);
  });

  it("owner can also approve (owner is approver)", async function () {
    const { vault, owner, txId } = await escalatedFixture();
    await expect(vault.connect(owner).approveTx(txId))
      .to.emit(vault, "TxApproved");
  });

  it("marks tx as executed after approval", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await vault.connect(approver).approveTx(txId);
    const [, , , , , executed,] = await vault.getPendingTx(txId);
    expect(executed).to.be.true;
  });

  it("approver can cancel a queued transaction", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await expect(vault.connect(approver).cancelTx(txId, "Policy violation"))
      .to.emit(vault, "TxCancelled")
      .withArgs(txId, approver.address, "Policy violation");
  });

  it("marks tx as cancelled after cancellation", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await vault.connect(approver).cancelTx(txId, "no");
    const [, , , , , , cancelled] = await vault.getPendingTx(txId);
    expect(cancelled).to.be.true;
  });

  it("cannot approve an already-executed transaction", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await vault.connect(approver).approveTx(txId);
    await expect(vault.connect(approver).approveTx(txId))
      .to.be.revertedWith("PolicyVault: already executed");
  });

  it("cannot approve a cancelled transaction", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await vault.connect(approver).cancelTx(txId, "reason");
    await expect(vault.connect(approver).approveTx(txId))
      .to.be.revertedWith("PolicyVault: already cancelled");
  });

  it("cannot cancel an executed transaction", async function () {
    const { vault, approver, txId } = await escalatedFixture();
    await vault.connect(approver).approveTx(txId);
    await expect(vault.connect(approver).cancelTx(txId, "late"))
      .to.be.revertedWith("PolicyVault: already executed");
  });

  it("stranger cannot approve", async function () {
    const { vault, stranger, txId } = await escalatedFixture();
    await expect(vault.connect(stranger).approveTx(txId))
      .to.be.revertedWith("PolicyVault: caller is not approver");
  });

  it("stranger cannot cancel", async function () {
    const { vault, stranger, txId } = await escalatedFixture();
    await expect(vault.connect(stranger).cancelTx(txId, "no"))
      .to.be.revertedWith("PolicyVault: caller is not approver");
  });
});

// ============================================================================
// DAILY SPENDING CAP — RESET LOGIC
// ============================================================================
describe("PolicyVault — Daily Reset", function () {
  it("resets dailySpent after UTC midnight", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);

    // Spend 2 ETH today
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t1");
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t2");
    expect(await vault.dailySpent()).to.equal(ethers.parseEther("2.0"));

    // Jump 25 hours into the future
    await time.increase(25 * 3600);

    // Now a new proposal should see a fresh daily tracker
    // (The daily reset happens inside propose)
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t3");
    expect(await vault.dailySpent()).to.equal(ONE_ETH);
  });

  it("checkPolicy sees fresh budget after midnight", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);

    // Exhaust the daily cap
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t1");
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t2");
    await vault.connect(agent).propose(recipient.address, ONE_ETH, "0x", "t3");

    // Without time travel, remaining = 0
    expect(await vault.remainingDailyBudget()).to.equal(0n);

    // Jump 25 hours
    await time.increase(25 * 3600);

    // Should now return full cap
    expect(await vault.remainingDailyBudget()).to.equal(ethers.parseEther("3.0"));
  });
});

// ============================================================================
// ACCESS CONTROL — NON-AGENTS
// ============================================================================
describe("PolicyVault — Access Control", function () {
  it("stranger cannot propose", async function () {
    const { vault, stranger, recipient } = await loadFixture(deployFixture);
    await expect(vault.connect(stranger).propose(recipient.address, ONE_GWEI, "0x", "hack"))
      .to.be.revertedWith("PolicyVault: caller is not agent");
  });

  it("propose reverts on zero address recipient", async function () {
    const { vault, agent } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).propose(ethers.ZeroAddress, ONE_GWEI, "0x", "bad"))
      .to.be.revertedWith("PolicyVault: invalid recipient");
  });

  it("propose reverts when amount is 0", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    await expect(vault.connect(agent).propose(recipient.address, 0n, "0x", "zero"))
      .to.be.revertedWith("PolicyVault: amount must be > 0");
  });

  it("propose reverts when vault has insufficient balance", async function () {
    const { vault, agent, recipient } = await loadFixture(deployFixture);
    const huge = ethers.parseEther("999");
    await expect(vault.connect(agent).propose(recipient.address, huge, "0x", "drain"))
      .to.be.revertedWith("PolicyVault: insufficient balance");
  });
});

// ============================================================================
// INTEGRATION — MULTI-STEP SCENARIO
// ============================================================================
describe("PolicyVault — Integration Scenarios", function () {
  it("full lifecycle: propose → escalate → approve", async function () {
    const { vault, agent, approver, recipient } = await loadFixture(deployFixture);

    const bigAmount = ethers.parseEther("1.5");
    const before = await ethers.provider.getBalance(recipient.address);

    // 1. Agent proposes (will ESCALATE — over per-tx limit)
    const proposeTx = await vault.connect(agent).propose(recipient.address, bigAmount, "0x", "salary");
    const proposeReceipt = await proposeTx.wait();
    const txId = vault.interface.parseLog(
      proposeReceipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;

    // 2. Approver reviews and executes
    await vault.connect(approver).approveTx(txId);

    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(bigAmount);
  });

  it("full lifecycle: propose → escalate → cancel → re-propose within limits", async function () {
    const { vault, agent, approver, recipient } = await loadFixture(deployFixture);

    const bigAmount = ethers.parseEther("1.5");
    const proposeTx = await vault.connect(agent).propose(recipient.address, bigAmount, "0x", "big");
    const proposeReceipt = await proposeTx.wait();
    const txId = vault.interface.parseLog(
      proposeReceipt.logs.find(l => { try { return vault.interface.parseLog(l)?.name === "TxProposed"; } catch { return false; } })
    )?.args.txId;

    // Cancel it
    await vault.connect(approver).cancelTx(txId, "Too large, split it");

    // Re-propose in two smaller chunks — both should auto-approve
    const before = await ethers.provider.getBalance(recipient.address);
    await vault.connect(agent).propose(recipient.address, HALF_ETH, "0x", "split1");
    await vault.connect(agent).propose(recipient.address, HALF_ETH, "0x", "split2");
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(ONE_ETH);
  });

  it("correctly blocks blacklisted address even if under limits", async function () {
    const { vault, agent, blacklistedAddr } = await loadFixture(deployFixture);
    await vault.setBlacklisted(blacklistedAddr.address, true);

    // Even tiny amounts should be REJECTED
    const tx = await vault.connect(agent).propose(blacklistedAddr.address, 1n, "0x", "tiny");
    const receipt = await tx.wait();
    const iface = vault.interface;
    const decisionLog = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === "PolicyDecision");

    expect(decisionLog.args.decision).to.equal(Decision.REJECT);
  });

  it("multiple agents can propose concurrently", async function () {
    const [owner, agent1, , recipient, , , agent2] = await ethers.getSigners();
    const PolicyVault = await ethers.getContractFactory("PolicyVault");
    const vault = await PolicyVault.deploy(ONE_ETH, ethers.parseEther("5.0"));
    await vault.waitForDeployment();
    await owner.sendTransaction({ to: vault.target, value: ethers.parseEther("10.0") });
    await vault.grantAgent(agent1.address);
    await vault.grantAgent(agent2.address);

    const before = await ethers.provider.getBalance(recipient.address);
    await vault.connect(agent1).propose(recipient.address, HALF_ETH, "0x", "a1");
    await vault.connect(agent2).propose(recipient.address, HALF_ETH, "0x", "a2");
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(ONE_ETH);
  });
});

// ============================================================================
// TEST RECEIVER (helper contract)
// ============================================================================

// We need a TestReceiver contract for the calldata forwarding test
// Define it inline via Hardhat artifacts
