# PolicyVault

> On-chain treasury with policy-enforced spending — deployed on Polkadot (Moonbeam).

[![Tests](https://img.shields.io/badge/tests-67%20passing-brightgreen)](https://github.com/helmutdeving/policy-vault)
[![Coverage](https://img.shields.io/badge/coverage-100%25%20stmts-brightgreen)](https://github.com/helmutdeving/policy-vault)
[![Solidity](https://img.shields.io/badge/solidity-0.8.24-blue)](https://soliditylang.org)
[![Network](https://img.shields.io/badge/network-Moonbase%20Alpha-purple)](https://docs.moonbeam.network/builders/get-started/networks/moonbase/)

## What is PolicyVault?

PolicyVault is a Solidity smart contract that acts as an **autonomous spending guard** for on-chain treasuries. Every outbound transaction is evaluated by an embedded policy engine before execution. Decisions are APPROVE, REJECT, or ESCALATE — and every decision is permanently recorded as a blockchain event.

This is the trustless, on-chain counterpart to off-chain AI treasury agents. Rules are enforced at the contract level, making them tamper-proof and auditable by anyone.

## How It Works

```
Agent proposes tx ──▶ Policy Engine ──▶ APPROVE  ──▶ Executed immediately
                              │──▶ REJECT   ──▶ Refused, reason logged
                              └──▶ ESCALATE ──▶ Queued for human approver
```

### Policy Rules (evaluated in order)

| Priority | Rule | Trigger | Decision |
|----------|------|---------|----------|
| 1 | Recipient blacklisted | `blacklisted[to] == true` | **REJECT** |
| 2 | Exceeds per-tx limit | `amount > maxTransactionAmount` | **ESCALATE** |
| 3 | Would exceed daily cap | `dailySpent + amount > dailySpendingCap` | **ESCALATE** |
| 4 | All clear | — | **APPROVE** |

### Roles

| Role | Permissions |
|------|------------|
| **Owner** | Configure policy params, manage roles, blacklist addresses |
| **Agent** | Propose transactions (AI agents, automation systems) |
| **Approver** | Approve or cancel escalated transactions |

## Architecture

```
PolicyVault.sol
├── propose(to, amount, data, description)   → Decision + auto-execute if APPROVE
├── approveTx(txId)                          → Human approves ESCALATE queue item
├── cancelTx(txId, reason)                   → Human rejects with audit reason
├── checkPolicy(to, amount)                  → Preview decision without proposing
├── remainingDailyBudget()                   → View remaining allowance today
└── Policy admin (setMaxTransactionAmount, setDailySpendingCap, setBlacklisted)
```

Every action emits events that form an **immutable on-chain audit trail**:

```solidity
event PolicyDecision(uint256 indexed txId, address indexed to, uint256 amount,
                     Decision decision, string reason, address indexed proposedBy);
event TxExecuted(uint256 indexed txId, address indexed to, uint256 amount);
event TxApproved(uint256 indexed txId, address indexed approver);
event TxCancelled(uint256 indexed txId, address indexed canceller, string reason);
```

## Deployment — Moonbase Alpha (Moonbeam Testnet)

Moonbeam is a Polkadot parachain with full EVM compatibility.

**Deployed contract**: `TBD` (see [deployment.json](./deployment.json) after deploy)
**Explorer**: [Moonbase Moonscan](https://moonbase.moonscan.io)

Network configuration:
- RPC: `https://rpc.api.moonbase.moonbeam.network`
- Chain ID: `1287`
- Native token: DEV (from [faucet](https://faucet.moonbeam.network))

Also compatible with **Polkadot Asset Hub** (ETH proxy / pallet_revive):
- RPC: `https://testnet-passet-hub-eth-rpc.polkadot.io`
- Chain ID: `420420422`

## Setup

```bash
git clone https://github.com/helmutdeving/policy-vault
cd policy-vault
npm install
```

Copy `.env.example` to `.env` and add your deployer private key:

```bash
cp .env.example .env
# Edit .env: DEPLOYER_PRIVATE_KEY=0x...
```

## Testing

```bash
# Run all tests
npx hardhat test

# With gas report
REPORT_GAS=true npx hardhat test

# Coverage report
npx hardhat coverage
```

**Test results**: 67 tests | 100% statement coverage | 100% function coverage

```
  PolicyVault — Deployment               9 passing
  PolicyVault — Role Management         10 passing
  PolicyVault — Policy Configuration    5 passing
  PolicyVault — Blacklist               4 passing
  PolicyVault — checkPolicy (view)      5 passing
  PolicyVault — propose: APPROVE path   5 passing
  PolicyVault — propose: REJECT path    4 passing
  PolicyVault — propose: ESCALATE path  4 passing
  PolicyVault — Approver Actions        9 passing
  PolicyVault — Daily Reset             2 passing
  PolicyVault — Access Control          4 passing
  PolicyVault — Integration Scenarios   4 passing

  67 passing
```

## Deploy

```bash
# Moonbase Alpha (Moonbeam testnet)
npx hardhat run scripts/deploy.js --network moonbaseAlpha

# Polkadot Asset Hub testnet
npx hardhat run scripts/deploy.js --network polkadotAssetHub

# Fund vault after deploy
FUND_VAULT=true npx hardhat run scripts/deploy.js --network moonbaseAlpha
```

Get testnet DEV tokens: [faucet.moonbeam.network](https://faucet.moonbeam.network)

## Why PolicyVault?

Most AI treasury solutions are off-chain (Node.js wrappers, LLM guardrails). When the server goes down, the guardrails disappear.

PolicyVault's rules live **in the contract** — they execute on every transaction, forever, without any server. There's no trusted operator who can bypass them. The policy is the contract.

This is meaningful for:
- **DeFi protocols** that want governance-controlled spending with audit trails
- **DAO treasuries** that need spending limits without full multisig overhead for every TX
- **Autonomous agents** that need on-chain enforceable constraints

## Security Considerations

- Policy checks are atomic with execution — no time-of-check/time-of-use window
- Daily spending cap uses UTC day boundaries (block.timestamp / 86400)
- Re-entrancy is mitigated by state-before-call ordering in `_execute`
- Role separation: agents cannot approve their own escalated transactions
- Ownership transfer is a single-step operation — use with care

## License

MIT
