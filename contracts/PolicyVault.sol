// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PolicyVault
 * @author helmutdev
 * @notice On-chain treasury with AI-enforced spending policies.
 *         Every outbound transaction is evaluated against configurable rules
 *         before execution. Decisions are APPROVE, REJECT, or ESCALATE,
 *         and every decision is permanently recorded as a blockchain event.
 *
 * @dev Architecture:
 *   - Agents (AI agents or automation) propose transactions
 *   - PolicyEngine evaluates the proposal against: blacklist, per-tx limit, daily cap
 *   - APPROVE  → executed immediately, atomically
 *   - REJECT   → permanently refused, reason recorded
 *   - ESCALATE → queued for human approver to accept or cancel
 *   - Approvers are human operators with veto/approve power over ESCALATE queue
 *   - Owner controls policy parameters and role assignments
 */
contract PolicyVault {
    // =========================================================================
    // TYPES
    // =========================================================================

    enum Decision { APPROVE, REJECT, ESCALATE }

    struct PendingTx {
        address to;
        uint256 amount;
        bytes   data;
        string  description;
        uint256 proposedAt;
        address proposedBy;
        bool    executed;
        bool    cancelled;
    }

    // =========================================================================
    // STATE
    // =========================================================================

    address public owner;

    // Policy parameters (configurable by owner)
    uint256 public maxTransactionAmount;  // max amount per single transaction (wei)
    uint256 public dailySpendingCap;      // max total spend per UTC day (wei)

    // Roles
    mapping(address => bool) public agents;    // can propose transactions
    mapping(address => bool) public approvers; // can approve/cancel ESCALATE queue

    // Blacklist — rejected immediately regardless of amount
    mapping(address => bool) public blacklisted;

    // Daily spending tracker
    uint256 public dailySpent;
    uint256 public lastResetDay; // UTC day number (block.timestamp / 86400)

    // Pending transaction queue (ESCALATE path)
    uint256 public nextTxId;
    mapping(uint256 => PendingTx) private _pending;

    // =========================================================================
    // EVENTS — immutable audit trail
    // =========================================================================

    /// @notice Emitted for every policy decision on every proposed transaction
    event PolicyDecision(
        uint256 indexed txId,
        address indexed to,
        uint256 amount,
        Decision decision,
        string reason,
        address indexed proposedBy
    );

    event TxProposed(uint256 indexed txId, address indexed to, uint256 amount, address proposedBy);
    event TxExecuted(uint256 indexed txId, address indexed to, uint256 amount);
    event TxApproved(uint256 indexed txId, address indexed approver);
    event TxCancelled(uint256 indexed txId, address indexed canceller, string reason);
    event TxRejected(uint256 indexed txId, address indexed to, uint256 amount, string reason);

    event PolicyUpdated(string indexed param, uint256 newValue, address indexed updatedBy);
    event BlacklistUpdated(address indexed addr, bool banned, address indexed updatedBy);
    event AgentUpdated(address indexed addr, bool granted, address indexed updatedBy);
    event ApproverUpdated(address indexed addr, bool granted, address indexed updatedBy);
    event Deposited(address indexed from, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier onlyOwner() {
        require(msg.sender == owner, "PolicyVault: caller is not owner");
        _;
    }

    modifier onlyAgent() {
        require(agents[msg.sender] || msg.sender == owner, "PolicyVault: caller is not agent");
        _;
    }

    modifier onlyApprover() {
        require(approvers[msg.sender] || msg.sender == owner, "PolicyVault: caller is not approver");
        _;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * @param _maxTxAmount    Maximum ETH per single transaction (in wei)
     * @param _dailyCap       Maximum ETH spendable per UTC day (in wei)
     */
    constructor(uint256 _maxTxAmount, uint256 _dailyCap) {
        require(_maxTxAmount > 0, "PolicyVault: maxTxAmount must be > 0");
        require(_dailyCap >= _maxTxAmount, "PolicyVault: dailyCap must be >= maxTxAmount");

        owner = msg.sender;
        maxTransactionAmount = _maxTxAmount;
        dailySpendingCap = _dailyCap;

        agents[msg.sender] = true;
        approvers[msg.sender] = true;
        lastResetDay = block.timestamp / 86400;
    }

    // =========================================================================
    // CORE: PROPOSE TRANSACTION
    // =========================================================================

    /**
     * @notice Propose an outbound transaction. The policy engine evaluates it
     *         and either executes immediately (APPROVE), records rejection (REJECT),
     *         or queues for human review (ESCALATE).
     *
     * @param to          Recipient address
     * @param amount      Amount in wei
     * @param data        Calldata to forward (empty for plain ETH transfers)
     * @param description Human-readable description for audit log
     * @return txId       Assigned transaction ID
     * @return decision   Policy decision: APPROVE, REJECT, or ESCALATE
     */
    function propose(
        address to,
        uint256 amount,
        bytes calldata data,
        string calldata description
    ) external onlyAgent returns (uint256 txId, Decision decision) {
        require(to != address(0), "PolicyVault: invalid recipient");
        require(amount > 0, "PolicyVault: amount must be > 0");
        require(address(this).balance >= amount, "PolicyVault: insufficient balance");

        _resetDailyIfNeeded();

        txId = nextTxId++;
        string memory reason;
        (decision, reason) = _evaluatePolicy(to, amount);

        // Store in pending queue regardless of decision (for auditability)
        _pending[txId] = PendingTx({
            to:          to,
            amount:      amount,
            data:        data,
            description: description,
            proposedAt:  block.timestamp,
            proposedBy:  msg.sender,
            executed:    false,
            cancelled:   false
        });

        emit TxProposed(txId, to, amount, msg.sender);
        emit PolicyDecision(txId, to, amount, decision, reason, msg.sender);

        if (decision == Decision.APPROVE) {
            _execute(txId);
        } else if (decision == Decision.REJECT) {
            _pending[txId].cancelled = true;
            emit TxRejected(txId, to, amount, reason);
        }
        // ESCALATE: left in queue, awaiting human approver

        return (txId, decision);
    }

    // =========================================================================
    // APPROVER ACTIONS
    // =========================================================================

    /**
     * @notice Approve a queued (ESCALATE) transaction for execution.
     *         The approver has reviewed the transaction and authorises it.
     */
    function approveTx(uint256 txId) external onlyApprover {
        PendingTx storage tx_ = _pending[txId];
        require(!tx_.executed,  "PolicyVault: already executed");
        require(!tx_.cancelled, "PolicyVault: already cancelled");
        require(address(this).balance >= tx_.amount, "PolicyVault: insufficient balance");

        emit TxApproved(txId, msg.sender);
        _execute(txId);
    }

    /**
     * @notice Cancel a queued transaction. Records the reason for auditability.
     */
    function cancelTx(uint256 txId, string calldata reason) external onlyApprover {
        PendingTx storage tx_ = _pending[txId];
        require(!tx_.executed,  "PolicyVault: already executed");
        require(!tx_.cancelled, "PolicyVault: already cancelled");

        tx_.cancelled = true;
        emit TxCancelled(txId, msg.sender, reason);
    }

    // =========================================================================
    // POLICY ENGINE (internal)
    // =========================================================================

    /**
     * @dev Pure policy evaluation — no state mutations. Order matters:
     *      1. Blacklist check  → REJECT (never allow)
     *      2. Per-tx limit     → ESCALATE (needs human review)
     *      3. Daily cap        → ESCALATE (needs human review)
     *      4. All clear        → APPROVE
     */
    function _evaluatePolicy(address to, uint256 amount)
        internal
        view
        returns (Decision, string memory)
    {
        if (blacklisted[to]) {
            return (Decision.REJECT, "Recipient is blacklisted");
        }
        if (amount > maxTransactionAmount) {
            return (Decision.ESCALATE, "Amount exceeds per-transaction limit");
        }
        uint256 effectiveSpent = _effectiveDailySpent();
        if (effectiveSpent + amount > dailySpendingCap) {
            return (Decision.ESCALATE, "Would exceed daily spending cap");
        }
        return (Decision.APPROVE, "Within policy limits");
    }

    /**
     * @dev View-compatible daily reset: returns 0 if we've crossed midnight UTC.
     */
    function _effectiveDailySpent() internal view returns (uint256) {
        uint256 today = block.timestamp / 86400;
        return (today > lastResetDay) ? 0 : dailySpent;
    }

    /**
     * @dev Mutating daily reset: clears dailySpent when UTC day rolls over.
     */
    function _resetDailyIfNeeded() internal {
        uint256 today = block.timestamp / 86400;
        if (today > lastResetDay) {
            dailySpent = 0;
            lastResetDay = today;
        }
    }

    /**
     * @dev Execute an approved or approver-authorised transaction.
     */
    function _execute(uint256 txId) internal {
        PendingTx storage tx_ = _pending[txId];
        tx_.executed = true;
        dailySpent += tx_.amount;

        (bool success, ) = tx_.to.call{value: tx_.amount}(tx_.data);
        require(success, "PolicyVault: execution failed");

        emit TxExecuted(txId, tx_.to, tx_.amount);
    }

    // =========================================================================
    // READ — PUBLIC POLICY CHECK
    // =========================================================================

    /**
     * @notice Preview what decision the policy engine would make.
     *         Useful for agents to dry-run before proposing.
     */
    function checkPolicy(address to, uint256 amount)
        external
        view
        returns (Decision decision, string memory reason)
    {
        if (blacklisted[to]) {
            return (Decision.REJECT, "Recipient is blacklisted");
        }
        if (amount > maxTransactionAmount) {
            return (Decision.ESCALATE, "Amount exceeds per-transaction limit");
        }
        uint256 effectiveSpent = _effectiveDailySpent();
        if (effectiveSpent + amount > dailySpendingCap) {
            return (Decision.ESCALATE, "Would exceed daily spending cap");
        }
        return (Decision.APPROVE, "Within policy limits");
    }

    /**
     * @notice Get details of a pending transaction.
     */
    function getPendingTx(uint256 txId)
        external
        view
        returns (
            address to,
            uint256 amount,
            string memory description,
            uint256 proposedAt,
            address proposedBy,
            bool executed,
            bool cancelled
        )
    {
        PendingTx storage tx_ = _pending[txId];
        return (
            tx_.to,
            tx_.amount,
            tx_.description,
            tx_.proposedAt,
            tx_.proposedBy,
            tx_.executed,
            tx_.cancelled
        );
    }

    /**
     * @notice Get the effective remaining daily budget.
     */
    function remainingDailyBudget() external view returns (uint256) {
        uint256 spent = _effectiveDailySpent();
        if (spent >= dailySpendingCap) return 0;
        return dailySpendingCap - spent;
    }

    // =========================================================================
    // ADMIN — POLICY CONFIGURATION
    // =========================================================================

    function setMaxTransactionAmount(uint256 amount) external onlyOwner {
        require(amount > 0, "PolicyVault: must be > 0");
        maxTransactionAmount = amount;
        emit PolicyUpdated("maxTransactionAmount", amount, msg.sender);
    }

    function setDailySpendingCap(uint256 amount) external onlyOwner {
        require(amount >= maxTransactionAmount, "PolicyVault: cap must be >= maxTxAmount");
        dailySpendingCap = amount;
        emit PolicyUpdated("dailySpendingCap", amount, msg.sender);
    }

    function setBlacklisted(address addr, bool banned) external onlyOwner {
        require(addr != address(0), "PolicyVault: invalid address");
        blacklisted[addr] = banned;
        emit BlacklistUpdated(addr, banned, msg.sender);
    }

    // =========================================================================
    // ADMIN — ROLE MANAGEMENT
    // =========================================================================

    function grantAgent(address addr) external onlyOwner {
        require(addr != address(0), "PolicyVault: invalid address");
        agents[addr] = true;
        emit AgentUpdated(addr, true, msg.sender);
    }

    function revokeAgent(address addr) external onlyOwner {
        agents[addr] = false;
        emit AgentUpdated(addr, false, msg.sender);
    }

    function grantApprover(address addr) external onlyOwner {
        require(addr != address(0), "PolicyVault: invalid address");
        approvers[addr] = true;
        emit ApproverUpdated(addr, true, msg.sender);
    }

    function revokeApprover(address addr) external onlyOwner {
        approvers[addr] = false;
        emit ApproverUpdated(addr, false, msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PolicyVault: invalid address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // =========================================================================
    // RECEIVE ETH
    // =========================================================================

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
