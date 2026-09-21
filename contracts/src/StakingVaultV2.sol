// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal core (v3.4) surface the vault depends on (spec §3).
interface IPowMintNFTv34 {
    function setStakingDiscount(address wallet, uint16 milliBits) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function stakingDiscountMilli(address wallet) external view returns (uint16);
}

/// @dev Minimal RarityRegistry (v1.1) surface the vault depends on (economy v1.1 spec §1/§2):
///      per-card rarity multiplier in bps (10000 = 1.0×). Key is `bytes32(uint256(tokenId))`.
interface IRarityRegistryLike {
    function bpsOf(bytes32 cardKey) external view returns (uint16);
}

/// @dev Minimal StakeRewards (v1.1) surface the vault pushes to (economy v1.1 spec §3):
///      `setWeight` checkpoints accrued rewards before re-weighting.
interface IStakeRewardsLike {
    function setWeight(address wallet, uint256 newWeight) external;
}

/// @title StakingVault v1 — Phase-2 stream B (custody + PoW-discount satellite).
///
/// Implements `staking spec` v1.1 verbatim. The vault:
///   - holds House Cards while staked and returns them **only to the staker**;
///   - grants a per-wallet PoW discount in the core v3.4 (`setStakingDiscount`, MILLI-BITS) equal to
///     the max tier milli-bits over that wallet's active stakes (tier 0 → 0: flexible = income only);
///   - tracks a notional `weight ×1000` accrual (bookkeeping for the future pool v1.1);
///   - **hard lock**: a card is locked until the end of its chosen term
///     (`stakedAt + lockDays(tier) · DAY`); there is NO early exit and NO emergency path.
///     Tier 0 (0 days) is flexible and may be withdrawn immediately.
///
/// Hard invariants (see spec §4):
///   - never holds ETH/USDC (no `payable`/`receive`);
///   - `paused` blocks `stake` only — `unstake` is NEVER blocked;
///   - `unstake` succeeds only at/after the end of the term (`Locked(until)` before);
///   - the core NFT address is `immutable`; the vault must be a core module or `stake` reverts.
contract StakingVaultV2 {
    // --------------------------------------------------------------- structs

    struct StakeInfo {
        address owner; // staker (only they may unstake)
        uint8 tier; // 0..5
        uint64 stakedAt; // unix ts
        uint64 accrued; // notional weight×10·seconds (pool bookkeeping v1.1)
        uint64 lastAccrual; // ts of last accrual
    }

    // --------------------------------------------------------------- constants

    uint8 internal constant TIER_COUNT = 6;
    uint64 internal constant DAY = 1 days;

    // tier index -> values (v3.4 ladder)
    // weightX1000 = [1000, 5000, 10000, 20000, 30000, 40000]   (finer scale than the old ×10)
    // milliBits   = [   0,  500,  1500,  3000,  4500,  6000]   (tenths of a bit; tier0 = no boost)
    // lockDays    = [   0,    7,    30,    90,   180,   365]

    // ---------------------------------------------------------------- storage

    /// @notice Core v3.1 (House Card) address, pinned at deployment.
    address public immutable nft;

    /// @notice Pauses `stake` only. `unstake` is never blocked.
    bool public paused;

    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice v1.1 RarityRegistry (bps multipliers). `0` → every card counts as 1.0×.
    address public registry;
    /// @notice v1.1 StakeRewards sink. `0` → no weight pushes.
    address public rewards;

    /// @notice tokenId -> stake record.
    mapping(uint256 => StakeInfo) public stakeInfo;
    /// @notice wallet -> list of staked tokenIds (swap-pop).
    mapping(address => uint256[]) private _stakesOf;
    /// @notice tokenId -> index inside `_stakesOf[owner]`.
    mapping(uint256 => uint256) private _indexInWallet;

    /// @notice Total number of active stakes across all wallets.
    uint256 private _stakeCount;

    // ----------------------------------------------------------------- events

    event Staked(uint256 indexed tokenId, address indexed owner, uint8 tier, uint16 milliBits);
    event Unstaked(uint256 indexed tokenId, address indexed owner);
    event BoostSet(address indexed wallet, uint16 milliBits);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event RegistrySet(address indexed registry);
    event RewardsSet(address indexed rewards);

    // ----------------------------------------------------------------- errors

    error NotOwnerRole();
    error ZeroAddress();
    error Paused();
    error BadTier(uint8 tier);
    error AlreadyStaked(uint256 tokenId);
    error NotStaked(uint256 tokenId);
    error NotStakeOwner(uint256 tokenId);
    error Locked(uint64 until);

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param nft_ core v3.1 (House Card) address; the vault must be added as a module
    ///             of the core via `setModule` before `stake` can succeed.
    constructor(address nft_) {
        if (nft_ == address(0)) revert ZeroAddress();
        nft = nft_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------- tiers

    /// @notice Reward weight ×1000 for a tier (v3.4: finer scale than the old ×10).
    function weightX1000(uint8 tier) public pure returns (uint256) {
        if (tier == 0) return 1000;
        if (tier == 1) return 5000;
        if (tier == 2) return 10000;
        if (tier == 3) return 20000;
        if (tier == 4) return 30000;
        return 40000;
    }

    /// @notice PoW discount in MILLI-BITS for a tier (v3.4). Tier 0 (0 days, flexible) grants NO
    ///         difficulty discount — flexible stakes earn only reward income. Locked tiers scale
    ///         tenuously: 7d → 0.5, 30d → 1.5, 90d → 3.0, 180d → 4.5, 365d → 6.0 bits.
    function milliBitsForTier(uint8 tier) public pure returns (uint16) {
        if (tier == 0) return 0;
        if (tier == 1) return 500;
        if (tier == 2) return 1500;
        if (tier == 3) return 3000;
        if (tier == 4) return 4500;
        return 6000;
    }

    /// @notice Lock length (days) for a tier (0/7/30/90/180/365).
    function lockDays(uint8 tier) public pure returns (uint64) {
        if (tier == 0) return 0;
        if (tier == 1) return 7;
        if (tier == 2) return 30;
        if (tier == 3) return 90;
        if (tier == 4) return 180;
        return 365;
    }

    // ------------------------------------------------------------------ stake

    /// @notice Stake a House Card under a tier. The vault must be a core module.
    /// @param tokenId House Card id owned by `msg.sender` (must be approved to the vault).
    /// @param tier tier index 0..5; frozen at stake time (no in-place upgrade).
    function stake(uint256 tokenId, uint8 tier) external {
        if (paused) revert Paused();
        if (tier >= TIER_COUNT) revert BadTier(tier);

        if (stakeInfo[tokenId].owner != address(0)) revert AlreadyStaked(tokenId);

        // Reverts itself if not approved / not the owner; a free-token lock (core) also
        // reverts here by design (spec §1/§9) — the vault does not special-case it.
        IPowMintNFTv34(nft).transferFrom(msg.sender, address(this), tokenId);

        StakeInfo storage s = stakeInfo[tokenId];
        s.owner = msg.sender;
        s.tier = tier;
        s.stakedAt = uint64(block.timestamp);
        s.accrued = 0;
        s.lastAccrual = uint64(block.timestamp);

        _stakesOf[msg.sender].push(tokenId);
        _indexInWallet[tokenId] = _stakesOf[msg.sender].length - 1;
        _stakeCount += 1;

        emit Staked(tokenId, msg.sender, tier, milliBitsForTier(tier));
        _refreshDiscount(msg.sender);
        _pushWeight(msg.sender);
    }

    // ---------------------------------------------------------------- unstake

    /// @notice Return a staked House Card to its staker. The lock is HARD (owner decision
    ///         18.09.2026): reverts with `Locked(lockEnd)` until `stakedAt + lockDays(tier)·DAY`
    ///         has passed. There is no early exit and no emergency path. Tier 0 (0 days) is
    ///         flexible and callable immediately. Never blocked by `paused`.
    function unstake(uint256 tokenId) external {
        StakeInfo storage s = stakeInfo[tokenId];

        // Hard lock: the card may only leave the vault at/after the end of its term.
        uint256 lockEnd = uint256(s.stakedAt) + uint256(lockDays(s.tier)) * DAY;
        if (block.timestamp < lockEnd) revert Locked(uint64(lockEnd));

        address staker = s.owner;
        if (staker == address(0)) revert NotStaked(tokenId);
        if (msg.sender != staker) revert NotStakeOwner(tokenId);

        _accrue(s);

        _removeStake(tokenId, staker);
        IPowMintNFTv34(nft).transferFrom(address(this), staker, tokenId);
        emit Unstaked(tokenId, staker);
        _refreshDiscount(staker);
        _pushWeight(staker);
    }

    // ----------------------------------------------------------------- views

    /// @notice tokenIds currently staked by `wallet` (order not significant).
    function stakesOf(address wallet) external view returns (uint256[] memory) {
        return _stakesOf[wallet];
    }

    /// @notice Total number of active stakes across all wallets.
    function stakeCount() external view returns (uint256) {
        return _stakeCount;
    }

    /// @notice Accrued notional weight·seconds for a live stake (stored + open interval).
    /// @dev Returns 0 for a token that is not staked.
    function accruedOf(uint256 tokenId) external view returns (uint64) {
        StakeInfo storage s = stakeInfo[tokenId];
        if (s.owner == address(0)) return 0;
        return _accruedValue(s);
    }

    /// @notice v1.1 aggregate reward weight for `wallet` (economy v1.1 spec §2):
    ///         `Σ (weightX10(tier) × bpsOf(tokenKey)) / 10000`, summed in `_stakesOf` order.
    /// @dev With `registry == 0` every card counts at 1.0× (bps 10000), so this is the plain
    ///      Σ weightX10 — the v1 notional weight. Integer division per term (order-stable).
    function weightOf(address wallet) external view returns (uint256) {
        return _weightOf(wallet);
    }

    /// @notice v1.1: push `wallet`'s current aggregate weight to `StakeRewards`
    ///         (economy v1.1 spec §2). Permissionless and idempotent; a no-op when `rewards==0`.
    function poke(address wallet) external {
        _pushWeight(wallet);
    }

    /// @notice v1.1 hook for `RarityRegistry` (economy v1.1 spec §1): re-push the weight of the
    ///         wallet that owns `cardKey` (a `bytes32(uint256(tokenId))`) if it is staked.
    ///         No-op for an unstaked key or when `rewards==0`. Permissionless and idempotent.
    function pokeIfStaked(bytes32 cardKey) external {
        address staker = stakeInfo[uint256(cardKey)].owner;
        if (staker == address(0)) return;
        _pushWeight(staker);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Pause/unpause `stake` only.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice v1.1: set the RarityRegistry used by `weightOf` (`0` disables rarity, 1.0×).
    function setRegistry(address registry_) external onlyOwner {
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice v1.1: set the StakeRewards sink pushed to on stake/unstake/poke (`0` disables).
    function setRewards(address rewards_) external onlyOwner {
        rewards = rewards_;
        emit RewardsSet(rewards_);
    }

    /// @notice Step 1: nominate a new owner. Nominee must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
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

    /// @dev Fold the open interval into stored `accrued` and reset `lastAccrual`.
    function _accrue(StakeInfo storage s) internal {
        s.accrued = _accruedValue(s);
        s.lastAccrual = uint64(block.timestamp);
    }

    /// @dev stored accrued + (now − lastAccrual) · weight×10 (before deleting the record).
    function _accruedValue(StakeInfo storage s) internal view returns (uint64) {
        uint256 pending = (block.timestamp - uint256(s.lastAccrual)) * weightX1000(s.tier);
        return uint64(uint256(s.accrued) + pending);
    }

    /// @dev Swap-pop `tokenId` out of the staker's list and clear the record.
    function _removeStake(uint256 tokenId, address staker) internal {
        uint256 idx = _indexInWallet[tokenId];
        uint256 lastIdx = _stakesOf[staker].length - 1;
        if (idx != lastIdx) {
            uint256 moved = _stakesOf[staker][lastIdx];
            _stakesOf[staker][idx] = moved;
            _indexInWallet[moved] = idx;
        }
        _stakesOf[staker].pop();
        delete _indexInWallet[tokenId];
        delete stakeInfo[tokenId];
        _stakeCount -= 1;
    }

    /// @dev Push the wallet's aggregate discount (max tier-bits over active stakes) to the
    ///      core. Reverts (with the core's `NotModule`) if the vault is not a module — by
    ///      design (spec §3): a staking vault that cannot grant the boost must not stake.
    function _refreshDiscount(address wallet) internal {
        uint16 milliBits = _maxMilliBits(wallet);
        IPowMintNFTv34(nft).setStakingDiscount(wallet, milliBits);
        emit BoostSet(wallet, milliBits);
    }

    /// @dev Max `milliBitsForTier` over the wallet's active stakes (0 if none).
    function _maxMilliBits(address wallet) internal view returns (uint16) {
        uint256 len = _stakesOf[wallet].length;
        uint16 best;
        for (uint256 i; i < len; ++i) {
            uint16 b = milliBitsForTier(stakeInfo[_stakesOf[wallet][i]].tier);
            if (b > best) best = b;
        }
        return best;
    }

    /// @dev v1.1 aggregate weight: Σ weightX10(tier) × bps / 10000 over `_stakesOf[wallet]`.
    ///      `registry == 0` ⇒ bps 10000 for every card (plain Σ weightX10, v1 notional weight).
    function _weightOf(address wallet) internal view returns (uint256 total) {
        address reg = registry;
        uint256 len = _stakesOf[wallet].length;
        for (uint256 i; i < len; ++i) {
            uint256 tokenId = _stakesOf[wallet][i];
            uint256 bps =
                reg == address(0) ? 10000 : uint256(IRarityRegistryLike(reg).bpsOf(bytes32(tokenId)));
            total += (weightX1000(stakeInfo[tokenId].tier) * bps) / 10000;
        }
    }

    /// @dev v1.1: push the wallet's aggregate weight to `StakeRewards`. No-op when `rewards==0`.
    ///      Callers must already have applied the storage change (arrays updated) so that
    ///      `_weightOf` reflects the post-change state.
    function _pushWeight(address wallet) internal {
        address rw = rewards;
        if (rw == address(0)) return;
        IStakeRewardsLike(rw).setWeight(wallet, _weightOf(wallet));
    }
}
