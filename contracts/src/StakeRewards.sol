// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StakeRewards v1.1 — continuous staking-revenue stream (economy v1.1 spec §3).
///
/// The treasury forwards native USDC (18-dec, the Arc settlement coin) into this contract
/// via `notify{value: amount}(duration)`, which merges the injection into a per-second stream
/// (`ratePerSec`). Revenue accrues continuously to stakers, weighted by the vault-pushed
/// weight of their cards (`setWeight`); anyone can withdraw their share at any time via
/// `claim`.
///
/// Frozen points (spec §3):
///   - 2-step ownership; `vault` settable (onlyVault gate on `setWeight`).
///   - state: `poolRemaining`, `ratePerSec`, `R` (×1e18), `lastUpdate`, `totalWeight`,
///     per-wallet `paid` / `accrued` / `weight`.
///   - `_accrue`: if `totalWeight>0`, `dt=now−lastUpdate; consumed=min(rate·dt, poolRemaining);
///     R += consumed·1e18/totalWeight; poolRemaining −= consumed`; `lastUpdate=now` always
///     (stream pauses while `totalWeight==0`, funds stay put).
///   - `notify`: `newPool = poolRemaining + msg.value`; `newRate = newPool / (poolRemaining/rate
///     + duration)` (or `msg.value/duration` when `rate==0`); requires `duration>0`, `value>0`.
///   - `setWeight` checkpoints the wallet BEFORE changing weight (anti retro-pay).
///   - `claim`: CEI, native `call{value}`, own reentrancy guard.
contract StakeRewards {
    // -------------------------------------------------------------- constants

    /// @dev Fixed-point scale for `R` (accrued revenue per unit weight).
    uint256 internal constant ACC = 1e18;

    // ---------------------------------------------------------------- storage

    /// @notice Vault allowed to push weights (source of truth for staking weights).
    address public vault;
    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice Undistributed native USDC held for the stream.
    uint256 public poolRemaining;
    /// @notice Current stream rate (18-dec USDC per second).
    uint256 public ratePerSec;
    /// @notice Accrued revenue per unit of weight ×1e18.
    uint256 public R;
    /// @notice Timestamp of the last accrual.
    uint256 public lastUpdate;
    /// @notice Sum of all wallet weights.
    uint256 public totalWeight;

    /// @notice wallet → weight (pushed by the vault).
    mapping(address => uint256) public weight;
    /// @notice wallet → `R` at the last checkpoint.
    mapping(address => uint256) public paid;
    /// @notice wallet → checkpointed (settled) revenue.
    mapping(address => uint256) public accrued;

    /// @dev Reentrancy guard for `claim`.
    bool private _locked;

    // ----------------------------------------------------------------- events

    event Notified(uint256 amount, uint256 duration, uint256 newRate, uint256 poolRemaining);
    event WeightSet(address indexed wallet, uint256 oldWeight, uint256 newWeight);
    event Claimed(address indexed wallet, uint256 amount);
    event VaultSet(address indexed vault);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotOwnerRole();
    error NotVault();
    error ZeroAmount();
    error BadDuration();
    error Reentrancy();
    error TransferFailed();

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ------------------------------------------------------------ constructor

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Forward `msg.value` native USDC into the stream, spread over `duration` seconds.
    /// @dev Merges the new pool into the current rate so the whole pool still drains in
    ///      `(poolRemaining/rate) + duration` seconds (spec §3).
    function notify(uint256 duration) external payable onlyOwner {
        if (duration == 0) revert BadDuration();
        if (msg.value == 0) revert ZeroAmount();

        // fold the elapsed stream first so `poolRemaining` is current.
        _accrue();

        uint256 newPool = poolRemaining + msg.value;
        uint256 newRate;
        if (ratePerSec == 0) {
            newRate = msg.value / duration;
        } else {
            newRate = newPool / (poolRemaining / ratePerSec + duration);
        }

        ratePerSec = newRate;
        poolRemaining = newPool;
        lastUpdate = block.timestamp;

        emit Notified(msg.value, duration, newRate, newPool);
    }

    // ------------------------------------------------------------------ weight

    /// @notice Set a wallet's weight (vault only). Checkpoints before the change.
    function setWeight(address wallet, uint256 newWeight) external onlyVault {
        _accrue();
        _checkpoint(wallet);

        uint256 old = weight[wallet];
        totalWeight = totalWeight - old + newWeight;
        weight[wallet] = newWeight;

        emit WeightSet(wallet, old, newWeight);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Claim all revenue accrued to `msg.sender` and reset their checkpoint.
    function claim() external nonReentrant {
        _accrue();
        _checkpoint(msg.sender);

        uint256 amount = accrued[msg.sender];
        accrued[msg.sender] = 0;

        if (amount != 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }

        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------- views

    /// @notice Revenue currently claimable by `wallet` (checkpointed + open interval).
    function pendingOf(address wallet) public view returns (uint256) {
        return accrued[wallet] + (weight[wallet] * (_rNext() - paid[wallet])) / ACC;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set the vault allowed to push weights.
    function setVault(address vault_) external onlyOwner {
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Step 1: nominate a new owner. Nominee must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2: accept ownership (only the pending owner).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwnerRole();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------- internals

    /// @dev Fold `R` into stored `accrued` for `wallet` and advance its checkpoint.
    function _checkpoint(address wallet) internal {
        uint256 delta = (weight[wallet] * (R - paid[wallet])) / ACC;
        if (delta != 0) accrued[wallet] += delta;
        paid[wallet] = R;
    }

    /// @dev Advance the stream to `block.timestamp`.
    function _accrue() internal {
        uint256 nowTs = block.timestamp;
        if (totalWeight == 0) {
            lastUpdate = nowTs;
            return;
        }
        uint256 dt = nowTs - lastUpdate;
        if (dt != 0) {
            uint256 consumed = ratePerSec * dt;
            if (consumed > poolRemaining) consumed = poolRemaining;
            if (consumed != 0) {
                R += (consumed * ACC) / totalWeight;
                poolRemaining -= consumed;
            }
        }
        lastUpdate = nowTs;
    }

    /// @dev `R` after a hypothetical `_accrue()` at `block.timestamp` (no state change).
    function _rNext() internal view returns (uint256) {
        if (totalWeight == 0) return R;
        uint256 dt = block.timestamp - lastUpdate;
        if (dt == 0) return R;
        uint256 consumed = ratePerSec * dt;
        if (consumed > poolRemaining) consumed = poolRemaining;
        return R + (consumed * ACC) / totalWeight;
    }
}
