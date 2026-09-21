// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal core (v3.4) surface CraftingControllerV2 depends on.
interface IPowMintNFTv34 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function seedOf(uint256 tokenId) external view returns (bytes32);
    function isFreeToken(uint256 tokenId) external view returns (bool);
    function currentWave() external view returns (uint256);
    function currentPrice() external view returns (uint256);
    function treasury() external view returns (address);
    function burn(uint256 tokenId) external;
    function forgeMint(address to, bytes32 seed) external;
    function totalForged() external view returns (uint256);
    function FORGE_ID_BASE() external view returns (uint256);
}

/// @dev Minimal RarityRegistry (v1.1) surface: per-card rarity multiplier in bps (10000 = 1.0×).
interface IRarityRegistryLike {
    function bpsOf(bytes32 cardKey) external view returns (uint16);
}

/// @dev Minimal BurnPoints (v1.1) surface.
interface IBurnPointsLike {
    function accrue(address to, uint256 amount) external;
}

/// @title CraftingControllerV2 — single-step crafting (2 → 1), NO refusal (owner decision 21.09.2026).
///
/// Delta vs v1 (commit-reveal):
///   - ONE transaction: the crafter escrows two cards, chooses inherited slots + boost tier, pays the
///     fee, and the parents are burned and the child forged **atomically**. There is no `commit`,
///     no `reveal`, no `refund` — “crafted = took it”, with no way to back out.
///   - Unpredictable child: `childSeed` is stored as an off-chain pre-seed; the art seed is derived as
///     `keccak256(childSeed ‖ blockhash(childMintBlock + 2))` (same post-inclusion entropy as minting,
///     enforced by the core's `mintBlockOf` on forged tokens). The crafter cannot pre-evaluate the child.
///   - `childSeed = keccak256("PoA_CRAFT_v2" ‖ seedLow ‖ seedHigh ‖ minId ‖ maxId ‖ door ‖ tier ‖ nonce ‖ keccak(choices))`
///     with parents canonicalized by tokenId.
///   - Free cards still cannot be crafted before wave 5 (mirror of the core transfer lock).
///   - All fees are settled immediately (no escrow reservation); `withdrawFees()` sweeps to treasury.
contract CraftingControllerV2 {
    // --------------------------------------------------------------- structs

    /// @notice One inherited slot: `parent` is 0 (cardA) or 1 (cardB). `slot` is 0..11.
    struct SlotChoice {
        uint8 slot;
        uint8 parent;
    }

    // -------------------------------------------------------------- constants

    /// @notice v2 has exactly one door: CRAFT_2_1 (2 → 1).
    uint8 public constant DOOR_CRAFT_2_1 = 0;
    /// @notice Highest selectable slot (0..11); legendary (12) is always entropy-derived.
    uint8 public constant MAX_SLOT = 11;
    /// @notice Highest boost tier usable (tier 4 reserved for season-2 doors).
    uint8 public constant MAX_BOOST_TIER = 3;
    /// @notice Free tokens are non-transferable below wave 5 (mirror of the core's lock).
    uint256 public constant LOCK_WAVES = 5;
    /// @notice Fixed base craft fee — 5 USDC on all waves.
    uint256 public constant CRAFT_FEE = 5 * 10 ** 18;

    // ---------------------------------------------------------------- storage

    /// @notice Core v3.4 (House Card) address, pinned at deployment.
    address public immutable nft;

    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice Pauses `craft`.
    bool public paused;

    /// @notice Global craft counter; folded into the child pre-seed (uniqueness).
    uint64 public craftNonce;
    /// @notice Cumulative fees collected (all settled immediately in v2).
    uint256 public totalFeesCollected;

    /// @notice v1.1 RarityRegistry (bps multipliers for burn-point accrual). `0` → 1.0×.
    address public registry;
    /// @notice v1.1 BurnPoints sink. `0` → no accrual on craft.
    address public points;

    // ----------------------------------------------------------------- events

    event Crafted(
        uint256 indexed childId,
        address indexed player,
        uint256 cardA,
        uint256 cardB,
        bytes32 childSeed,
        uint8 boostTier,
        uint256 fee
    );
    event FeesWithdrawn(address indexed to, uint256 amount);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event RegistrySet(address indexed registry);
    event PointsSet(address indexed points);

    // ----------------------------------------------------------------- errors

    error NotOwnerRole();
    error ZeroAddress();
    error Paused();
    error SameCard();
    error BadTier(uint8 tier);
    error WrongPayment(uint256 sent, uint256 need);
    error FreeTokenLocked(uint256 tokenId);
    error TooManyChoices(uint256 got);
    error BadSlot(uint8 slot);
    error SlotsNotIncreasing();
    error BadParent(uint8 parent);
    error WithdrawFailed();
    error NothingToWithdraw();

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param nft_ core v3.4 address; the controller must be added as a core module
    ///             (`setModule`) before `craft` can forge.
    constructor(address nft_) {
        if (nft_ == address(0)) revert ZeroAddress();
        nft = nft_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Base crafting fee = `CRAFT_FEE` (fixed 5 USDC on all waves, 18-dec native).
    function craftFee() public pure returns (uint256) {
        return CRAFT_FEE;
    }

    /// @notice Boost cost for a tier: 0 at tier 0, else `0.5 × price × 2^(tier−1)`.
    function boostCost(uint8 tier) public view returns (uint256) {
        if (tier == 0) return 0;
        return (IPowMintNFTv34(nft).currentPrice() * (uint256(1) << (tier - 1))) / 2;
    }

    /// @notice Total fee required for a craft at `tier` (`craftFee + boostCost`).
    function feeFor(uint8 tier) public view returns (uint256) {
        return craftFee() + boostCost(tier);
    }

    /// @notice Max number of chosen slots for a tier: `min(6 + 2·tier, 12)`.
    function maxChosen(uint8 tier) public pure returns (uint256) {
        uint256 n = 6 + 2 * uint256(tier);
        return n > 12 ? 12 : n;
    }

    // --------------------------------------------------------------- crafting

    /// @notice Craft a child from two cards in ONE transaction (no refusal): the two cards are
    ///         burned and the child is forged atomically to `msg.sender`.
    /// @param cardA first card (any order; canonicalized against cardB by tokenId).
    /// @param cardB second card; must differ from `cardA`.
    /// @param choices inherited slots (slots strictly increasing, parent ≤ 1).
    /// @param boostTier 0..3 (tier 4 reserved for season-2 doors).
    /// @dev Caller must have approved this controller for both cards.
    function craft(uint256 cardA, uint256 cardB, SlotChoice[] calldata choices, uint8 boostTier) external payable {
        if (paused) revert Paused();
        if (cardA == cardB) revert SameCard();
        if (boostTier > MAX_BOOST_TIER) revert BadTier(boostTier);

        uint256 fee = craftFee() + boostCost(boostTier);
        if (msg.value != fee) revert WrongPayment(msg.value, fee);

        _checkCard(cardA);
        _checkCard(cardB);
        _validateChoices(choices, boostTier);

        IPowMintNFTv34 core = IPowMintNFTv34(nft);

        // escrow: reverts itself on missing approval / wrong owner / locked free token.
        core.transferFrom(msg.sender, address(this), cardA);
        core.transferFrom(msg.sender, address(this), cardB);

        // canonicalize parents by tokenId: seedLow/seedHigh follow minId/maxId.
        (uint256 minId, uint256 maxId, bytes32 seedLow, bytes32 seedHigh) = _parents(cardA, cardB);

        uint64 nonce = craftNonce;
        craftNonce = nonce + 1;

        // pre-seed: no entropy baked in — entropy is added off-chain from a later block hash.
        bytes32 childSeed = keccak256(
            abi.encodePacked(
                "PoA_CRAFT_v2",
                seedLow,
                seedHigh,
                minId,
                maxId,
                DOOR_CRAFT_2_1,
                boostTier,
                nonce,
                keccak256(abi.encode(choices))
            )
        );

        // atomic burn of the escrowed parents (this contract owns them) → funds the forge quota,
        // then forge the child (reverts if forgePaused / quota).
        core.burn(cardA);
        core.burn(cardB);
        core.forgeMint(msg.sender, childSeed);

        totalFeesCollected += fee;

        uint256 childId = core.FORGE_ID_BASE() + core.totalForged() - 1;

        // v1.1: burn-points for the two consumed parents by rarity (registry==0 ⇒ bps 10000).
        address points_ = points;
        if (points_ != address(0)) {
            uint256 ptsA = (10 * _parentBps(cardA)) / 10000;
            uint256 ptsB = (10 * _parentBps(cardB)) / 10000;
            IBurnPointsLike(points_).accrue(msg.sender, ptsA + ptsB);
        }

        emit Crafted(childId, msg.sender, cardA, cardB, childSeed, boostTier, fee);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sweep collected craft fees to the core's treasury.
    function withdrawFees() external onlyOwner {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();
        address to = IPowMintNFTv34(nft).treasury();
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit FeesWithdrawn(to, amount);
    }

    /// @notice Pause/unpause `craft`.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice v1.1: set the RarityRegistry used for burn-point accrual (`0` → 1.0×).
    function setRegistry(address registry_) external onlyOwner {
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice v1.1: set the BurnPoints sink credited on craft (`0` disables accrual).
    function setPoints(address points_) external onlyOwner {
        points = points_;
        emit PointsSet(points_);
    }

    /// @notice Step 1: nominate a new owner. Nominee must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2: accept ownership (callable only by the pending owner).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwnerRole();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------- internals

    /// @dev Canonical parent ordering by tokenId (seedLow follows minId).
    function _parents(uint256 cardA, uint256 cardB)
        internal
        view
        returns (uint256 minId, uint256 maxId, bytes32 seedLow, bytes32 seedHigh)
    {
        IPowMintNFTv34 core = IPowMintNFTv34(nft);
        if (cardA < cardB) {
            (minId, maxId) = (cardA, cardB);
            (seedLow, seedHigh) = (core.seedOf(cardA), core.seedOf(cardB));
        } else {
            (minId, maxId) = (cardB, cardA);
            (seedLow, seedHigh) = (core.seedOf(cardB), core.seedOf(cardA));
        }
    }

    /// @dev v1.1: rarity bps of a parent card (10000 when no registry is configured).
    function _parentBps(uint256 card) internal view returns (uint256) {
        address reg = registry;
        if (reg == address(0)) return 10000;
        return uint256(IRarityRegistryLike(reg).bpsOf(bytes32(card)));
    }

    /// @dev Explicit free-token lock: a free card may only be crafted at `currentWave >= 5`.
    function _checkCard(uint256 card) internal view {
        IPowMintNFTv34 core = IPowMintNFTv34(nft);
        if (core.isFreeToken(card) && core.currentWave() < LOCK_WAVES) revert FreeTokenLocked(card);
    }

    /// @dev Structural validation of `choices`: bounded length, slots strictly increasing
    ///      (⇒ unique) and ≤ 11, parent ≤ 1.
    function _validateChoices(SlotChoice[] calldata choices, uint8 boostTier) internal pure {
        uint256 n = choices.length;
        if (n > maxChosen(boostTier)) revert TooManyChoices(n);

        int256 prev = -1;
        for (uint256 i; i < n; ++i) {
            uint8 slot = choices[i].slot;
            if (slot > MAX_SLOT) revert BadSlot(slot);
            if (int256(uint256(slot)) <= prev) revert SlotsNotIncreasing();
            prev = int256(uint256(slot));
            if (choices[i].parent > 1) revert BadParent(choices[i].parent);
        }
    }
}
