// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal core (v3.1) surface CraftingController v1 depends on (HC/2 spec §3).
interface IPowMintNFTv31 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function seedOf(uint256 tokenId) external view returns (bytes32);
    function isFreeToken(uint256 tokenId) external view returns (bool);
    function currentWave() external view returns (uint256);
    function currentPrice() external view returns (uint256);
    function forgePaused() external view returns (bool);
    function treasury() external view returns (address);
    function burn(uint256 tokenId) external;
    function forgeMint(address to, bytes32 seed) external;
}

/// @dev Minimal RarityRegistry (v1.1) surface the controller depends on (economy v1.1 spec §1):
///      per-card rarity multiplier in bps (10000 = 1.0×). Key is `bytes32(uint256(tokenId))`.
interface IRarityRegistryLike {
    function bpsOf(bytes32 cardKey) external view returns (uint16);
}

/// @dev Minimal BurnPoints (v1.1) surface the controller depends on (economy v1.1 spec §4).
interface IBurnPointsLike {
    function accrue(address to, uint256 amount) external;
}

/// @title CraftingController v1 — Phase-2 stream C (commit-reveal crafting satellite).
///
/// Implements `HC/2 spec` v1 + `red-team notes` (blockers F-01..F-04) verbatim.
/// A player escrows two House Cards, commits to a `choices` hash + boost tier + fee, and —
/// after a short window fixed by future block entropy — reveals the choices; the two cards
/// are burned and a forged child (`FORGE_ID_BASE + N`) is minted to the committer with a
/// `childSeed` derived from both parents' seeds, canonical ids, tier, nonce and entropy.
///
/// Frozen invariants (HC/2 spec §3/§4):
///   - `entropy = blockhash(commitBlock + 2)`; reveal only in `[commit+3, commit+258]`
///     (`ENTROPY_DELAY=2` because `blockhash(current)=0` — F-01) and `entropy != 0`.
///   - `childSeed = keccak256(abi.encodePacked("PoA_CRAFT_v1", seedLow, seedHigh,
///      uint256(minId), uint256(maxId), uint8 door, uint8 boostTier, uint64 craftNonce,
///      bytes32 entropy))` with parents canonicalized by tokenId (F-04).
///   - `reveal` is **permissionless** (RT-6); the child always goes to the committer.
///     W3-01 fix: on-chain preimage = `keccak256(abi.encode(choices, salt))` with a
///     client-side secret `salt`, so the public commit record is not brute-forceable
///     (a third party cannot force-settle a commit and deny the committer's `refund`).
///   - `refund` returns **cards only** (fees are an anti-grind option premium); exception:
///      if the core's `forgePaused()` is set at refund time the full fee is returned (RT-5).
///   - explicit free-token lock mirror: a free card may only be committed at `currentWave≥5`.
///   - fees stay in the controller; `withdrawFees()` (owner) sweeps **settled** fees only —
///     open commits' fees stay reserved for potential refunds (W3-02 fix).
contract CraftingController {
    // --------------------------------------------------------------- structs

    /// @notice One inherited slot: `parent` is 0 (cardA) or 1 (cardB). `slot` is 0..11.
    struct SlotChoice {
        uint8 slot;
        uint8 parent;
    }

    /// @notice A single commit record. `nonce` is the global craft counter; `commitBlock`
    ///         anchors both the entropy and the reveal/refund windows.
    struct Commit {
        address player;
        uint256 cardA;
        uint256 cardB;
        bytes32 choicesHash;
        uint8 boostTier;
        uint64 nonce;
        uint64 commitBlock;
        uint256 fee;
        bool revealed;
        bool refunded;
    }

    // -------------------------------------------------------------- constants

    /// @notice v1 has exactly one door: CRAFT_2_1 (2 → 1). Season-2 doors reuse the field.
    uint8 public constant DOOR_CRAFT_2_1 = 0;
    /// @notice Entropy block offset: `entropy = blockhash(commitBlock + 2)` (F-01).
    uint256 public constant ENTROPY_DELAY = 2;
    /// @notice Earliest reveal block offset: `commitBlock + 3`.
    uint256 public constant MIN_REVEAL_DELAY = 3;
    /// @notice Latest reveal block offset: `commitBlock + 258` (keeps the entropy block in
    ///         the 256-block BLOCKHASH window).
    uint256 public constant REVEAL_WINDOW = 258;
    /// @notice Highest selectable slot (0..11); legendary (12) is always entropy-derived (F-03).
    uint8 public constant MAX_SLOT = 11;
    /// @notice Highest boost tier usable in v1 (tier 4 is reserved for season-2 doors).
    uint8 public constant MAX_BOOST_TIER = 3;
    /// @notice Free tokens are non-transferable below wave 5 (mirror of the core's lock).
    uint256 public constant LOCK_WAVES = 5;
    /// @notice fixed base craft fee — 5 USDC on all waves (owner decision 2026-09-19;
    ///         was 0.1× currentPrice).
    uint256 public constant CRAFT_FEE = 5 * 10 ** 18;

    // ---------------------------------------------------------------- storage

    /// @notice Core v3.1 (House Card) address, pinned at deployment.
    address public immutable nft;

    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer, like StakingVault.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice Pauses `commit` and `reveal`. `refund` is never blocked.
    bool public paused;

    /// @notice Id of the last commit (commit ids are 1-based).
    uint256 public lastCommitId;
    /// @notice Global craft counter; incremented on every commit and folded into `childSeed`.
    uint64 public craftNonce;
    /// @notice Sum of fees held for open commits; reserved for refunds, not withdrawable (W3-02).
    uint256 public committedFees;

    /// @notice commitId → commit record.
    mapping(uint256 => Commit) public commits;

    /// @notice v1.1 RarityRegistry (bps multipliers for burn-point accrual). `0` → 1.0×.
    address public registry;
    /// @notice v1.1 BurnPoints sink. `0` → no accrual on reveal.
    address public points;

    // ----------------------------------------------------------------- events

    event Committed(
        uint256 indexed commitId,
        address indexed player,
        uint256 cardA,
        uint256 cardB,
        bytes32 choicesHash,
        uint8 boostTier,
        uint64 nonce,
        uint256 fee
    );
    event Crafted(
        uint256 indexed commitId,
        address indexed player,
        uint256 cardA,
        uint256 cardB,
        bytes32 childSeed,
        bytes32 entropy,
        SlotChoice[] choices
    );
    event Refunded(uint256 indexed commitId, address indexed player, uint256 feeRefunded);
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
    error BadHash();
    error BadTier(uint8 tier);
    error WrongPayment(uint256 sent, uint256 need);
    error FreeTokenLocked(uint256 tokenId);
    error NoCommit();
    error AlreadySettled();
    error OutsideWindow();
    error NoEntropy();
    error HashMismatch();
    error TooManyChoices(uint256 got);
    error BadSlot(uint8 slot);
    error SlotsNotIncreasing();
    error BadParent(uint8 parent);
    error NotCommitter();
    error WindowOpen();
    error RefundFailed();
    error WithdrawFailed();
    error NothingToWithdraw();

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param nft_ core v3.1 (House Card) address; the controller must be added as a core
    ///             module (`setModule`) before `reveal` can forge.
    constructor(address nft_) {
        if (nft_ == address(0)) revert ZeroAddress();
        nft = nft_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Base crafting fee = `CRAFT_FEE` (fixed 5 USDC on all waves, 18-dec native).
    function craftFee() public view returns (uint256) {
        return CRAFT_FEE;
    }

    /// @notice Boost cost for a tier: 0 at tier 0, else `0.5 × price × 2^(tier−1)`.
    function boostCost(uint8 tier) public view returns (uint256) {
        if (tier == 0) return 0;
        return (IPowMintNFTv31(nft).currentPrice() * (uint256(1) << (tier - 1))) / 2;
    }

    /// @notice Total fee required for a commit at `tier` (`craftFee + boostCost`).
    function feeFor(uint8 tier) public view returns (uint256) {
        return craftFee() + boostCost(tier);
    }

    /// @notice Max number of chosen slots for a tier: `min(6 + 2·tier, 12)`.
    function maxChosen(uint8 tier) public pure returns (uint256) {
        uint256 n = 6 + 2 * uint256(tier);
        return n > 12 ? 12 : n;
    }

    // --------------------------------------------------------------- crafting

    /// @notice Escrow two cards and commit to a `choices` hash, boost tier and fee.
    /// @param cardA first card (any order; canonicalized against cardB by tokenId).
    /// @param cardB second card; must differ from `cardA`.
    /// @param slotChoicesHash `keccak256(abi.encode(SlotChoice[], salt))`; salt is a
    ///        client-side secret (W3-01); must be non-zero.
    /// @param boostTier 0..3 (tier 4 reserved for season-2 doors).
    function commit(uint256 cardA, uint256 cardB, bytes32 slotChoicesHash, uint8 boostTier) external payable {
        if (paused) revert Paused();
        if (cardA == cardB) revert SameCard();
        if (slotChoicesHash == bytes32(0)) revert BadHash();
        if (boostTier > MAX_BOOST_TIER) revert BadTier(boostTier);

        uint256 fee = craftFee() + boostCost(boostTier);
        if (msg.value != fee) revert WrongPayment(msg.value, fee);

        // defense-in-depth free-token lock (RT-2): mirror of the core's transfer lock.
        _checkCard(cardA);
        _checkCard(cardB);

        // escrow: reverts itself on missing approval / wrong owner / locked free token.
        IPowMintNFTv31(nft).transferFrom(msg.sender, address(this), cardA);
        IPowMintNFTv31(nft).transferFrom(msg.sender, address(this), cardB);

        uint256 id = ++lastCommitId;
        uint64 nonce = craftNonce;
        craftNonce = nonce + 1;

        commits[id] = Commit({
            player: msg.sender,
            cardA: cardA,
            cardB: cardB,
            choicesHash: slotChoicesHash,
            boostTier: boostTier,
            nonce: nonce,
            commitBlock: uint64(block.number),
            fee: fee,
            revealed: false,
            refunded: false
        });
        committedFees += fee; // W3-02: reserved until settle

        emit Committed(id, msg.sender, cardA, cardB, slotChoicesHash, boostTier, nonce, fee);
    }

    /// @notice Reveal the committed choices and settle the craft. **Permissionless** (RT-6):
    ///         any caller may reveal; the forged child always goes to the committer.
    /// @param commitId commit to settle.
    /// @param choices inherited slots; abi-encoded hash must equal the committed hash.
    /// @param salt client-side secret mixed into the committed hash (W3-01 fix).
    function reveal(uint256 commitId, SlotChoice[] calldata choices, bytes32 salt) external {
        if (paused) revert Paused();

        Commit storage c = commits[commitId];
        if (c.player == address(0)) revert NoCommit();
        if (c.revealed || c.refunded) revert AlreadySettled();

        uint256 low = uint256(c.commitBlock) + MIN_REVEAL_DELAY;
        uint256 high = uint256(c.commitBlock) + REVEAL_WINDOW;
        if (block.number < low || block.number > high) revert OutsideWindow();

        bytes32 entropy = blockhash(uint256(c.commitBlock) + ENTROPY_DELAY);
        if (entropy == bytes32(0)) revert NoEntropy();

        if (keccak256(abi.encode(choices, salt)) != c.choicesHash) revert HashMismatch();
        _validateChoices(choices, c.boostTier);

        // canonicalize parents by tokenId (F-04): seedLow/seedHigh follow minId/maxId.
        uint256 minId;
        uint256 maxId;
        bytes32 seedLow;
        bytes32 seedHigh;
        if (c.cardA < c.cardB) {
            minId = c.cardA;
            maxId = c.cardB;
            seedLow = IPowMintNFTv31(nft).seedOf(c.cardA);
            seedHigh = IPowMintNFTv31(nft).seedOf(c.cardB);
        } else {
            minId = c.cardB;
            maxId = c.cardA;
            seedLow = IPowMintNFTv31(nft).seedOf(c.cardB);
            seedHigh = IPowMintNFTv31(nft).seedOf(c.cardA);
        }

        bytes32 childSeed = keccak256(
            abi.encodePacked(
                "PoA_CRAFT_v1", seedLow, seedHigh, minId, maxId, DOOR_CRAFT_2_1, c.boostTier, c.nonce, entropy
            )
        );

        // effects before interactions (CEI / F-10).
        c.revealed = true;
        committedFees -= c.fee; // W3-02: fee is earned, no longer reserved

        IPowMintNFTv31(nft).burn(c.cardA);
        IPowMintNFTv31(nft).burn(c.cardB);
        IPowMintNFTv31(nft).forgeMint(c.player, childSeed);

        // v1.1 (economy v1.1 spec §4): burn-points for the two consumed parents by rarity.
        // ptsX = 10 × bpsOf(keyX) / 10000 (registry==0 ⇒ bps 10000). Points are not money.
        address points_ = points;
        if (points_ != address(0)) {
            uint256 ptsA = (10 * _parentBps(c.cardA)) / 10000;
            uint256 ptsB = (10 * _parentBps(c.cardB)) / 10000;
            IBurnPointsLike(points_).accrue(c.player, ptsA + ptsB);
        }

        emit Crafted(commitId, c.player, c.cardA, c.cardB, childSeed, entropy, choices);
    }

    /// @notice Return the two escrowed cards to the committer after the reveal window.
    /// @dev Fees are **not** returned (anti-grind option premium, RT-1). Exception: if the
    ///      core's `forgePaused()` is set at refund time the full fee is returned (RT-5).
    function refund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.player == address(0)) revert NoCommit();
        if (msg.sender != c.player) revert NotCommitter();
        if (c.revealed || c.refunded) revert AlreadySettled();
        if (block.number <= uint256(c.commitBlock) + REVEAL_WINDOW) revert WindowOpen();

        // effects before interactions (CEI).
        c.refunded = true;
        committedFees -= c.fee; // W3-02: reservation released (fee kept or fully returned below)

        IPowMintNFTv31(nft).transferFrom(address(this), c.player, c.cardA);
        IPowMintNFTv31(nft).transferFrom(address(this), c.player, c.cardB);

        uint256 feeBack;
        if (IPowMintNFTv31(nft).forgePaused()) {
            feeBack = c.fee;
            (bool ok,) = c.player.call{value: feeBack}("");
            if (!ok) revert RefundFailed();
        }

        emit Refunded(commitId, c.player, feeBack);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sweep **settled** fees to the core's treasury. Fees of open commits stay
    ///         reserved so refunds keep working (W3-02 fix).
    function withdrawFees() external onlyOwner {
        uint256 amount = address(this).balance - committedFees;
        if (amount == 0) revert NothingToWithdraw();
        address to = IPowMintNFTv31(nft).treasury();
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit FeesWithdrawn(to, amount);
    }

    /// @notice Pause/unpause `commit` and `reveal`. `refund` is never blocked.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice v1.1: set the RarityRegistry used for burn-point accrual (`0` → 1.0×).
    function setRegistry(address registry_) external onlyOwner {
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice v1.1: set the BurnPoints sink credited on reveal (`0` disables accrual).
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

    /// @dev v1.1: rarity bps of a parent card (10000 when no registry is configured).
    function _parentBps(uint256 card) internal view returns (uint256) {
        address reg = registry;
        if (reg == address(0)) return 10000;
        return uint256(IRarityRegistryLike(reg).bpsOf(bytes32(card)));
    }

    /// @dev Explicit free-token lock: a free card may only be committed at `currentWave >= 5`.
    function _checkCard(uint256 card) internal view {
        IPowMintNFTv31 core = IPowMintNFTv31(nft);
        if (core.isFreeToken(card) && core.currentWave() < LOCK_WAVES) revert FreeTokenLocked(card);
    }

    /// @dev Structural validation of `choices` (HC/2 spec §3, RT-4): bounded length, slots
    ///      strictly increasing (⇒ unique) and ≤ 11, parent ≤ 1.
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
