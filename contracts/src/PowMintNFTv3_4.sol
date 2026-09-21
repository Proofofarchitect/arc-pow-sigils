// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Minimal} from "./ERC721Minimal.sol";

/// @title PowMintNFTv3_4 — "Proof of Architect" v3.4 (Arc Chain, USDC gas).
// v3.2 (2026-09-19): optional mint fee — immutable mintFeeBps (≤10%), totalFees counter, currentMintDue() helper; mainnet target 250 bps; deployed testnet v3.1 instances remain fee-less (0 bps).
// v3.3 (2026-09-19): anti-sybil delta — cooldown() is now a FLAT schedule by streak level (5/10/15/20/25 min for levels 1..5, cap 25 min; COOLDOWN_BASE × wave removed); pace regulator uses an asymmetric step (+2 bits when fast, −1 bit when slow) with deploy defaults regWindow=5 / paceTargetS=25. Streak semantics (+2 bits per mint within window) unchanged.
// v3.4 (2026-09-21): (1) POST-INCLUSION ENTROPY — `mintBlockOf[id]` records the mint block; the art seed is
//        derived OFF-CHAIN as keccak256(seedOf[id] ‖ blockhash(mintBlockOf[id] + SEED_DELAY_BLOCKS)), using a
//        block hash that does not exist when the miner submits. This removes free off-chain rarity grinding
//        (a miner can no longer pick the prettiest of many valid nonces). No extra tx / no keeper needed —
//        block hashes are permanently readable via RPC. Claim tokens keep their deterministic seed (mintBlockOf == 0).
//        Loss: the "preview traits before mint" feature (and `verify_rarity` pre-mint) no longer applies.
//        (2) FRACTIONAL DIFFICULTY — the required work is now `work < targetFor(miner)`, where the staking discount
//        is expressed in MILLI-BITS (thousandths of a bit) so lock-time boosts can be tenuous (0.5 / 1.5 / 3.0 …).
//        Range guards keep the target within the wave-1 floor (`baseBits`).
///
/// = v3 + the minimal pre-mainnet delta (v3.1 spec):
///   1. `burn(tokenId)`            — holder/approved burn; increments `totalBurned`.
///   2. `forgeMint(to, seed)`      — module-only mint funded by burns (forge quota:
///                                   `totalForged < totalBurned`), ids ≥ FORGE_ID_BASE.
///   3. `authorizedModules`        — Safe-managed registry; only modules may forge /
///                                   set staking discounts.
///   4. `stakingDiscountMilli`     — PoW-boost hook: modules (staking vault) may grant
///                                   ≤ MAX_DISCOUNT_MILLI (milli-bits) off requiredBits; floor = baseBits.
///
/// Mint model (v3.4):
///   work = keccak256(chainid ‖ address(this) ‖ miner ‖ nonce)
///   valid ⟺ uint256(work) < targetFor(miner)   (fractional difficulty; capped at 250 bits)
///   art seed = keccak256(seedOf[id] ‖ blockhash(mintBlockOf[id] + SEED_DELAY_BLOCKS))  [off-chain]
///
/// Economy (unchanged from v3):
///   - `freeClaims` tokens are claimable with a code (no PoW), 42 influencer slots,
///   - paid price = priceStart × 2^epochIndex, epochIndex = paidMinted / epochSize,
///   - free tokens are non-transferable until wave >= LOCK_WAVES.
///
/// v3.1 invariants:
///   - `totalForged <= totalBurned` (forge strictly funded by burns),
///   - circulating = totalMinted − totalBurned + totalForged <= maxSupply (always),
///   - burns never move the price ladder (`paidMinted`/`epochIndex` untouched).
contract PowMintNFTv3_4 is ERC721Minimal {
    // --------------------------------------------------------------- errors

    error BelowFloor(uint8 got, uint8 need);
    error BelowTarget(uint256 work, uint256 target);
    error WrongPayment(uint256 sent, uint256 need);
    error NonceUsed();
    error SoldOut();
    error MintPaused();
    error NotOwnerRole();
    error ZeroAddress();
    error InvalidTreasury();
    error BadConfig();
    error WithdrawFailed();
    error FreeTokenLocked(uint256 tokenId);
    error InvalidCode();
    error ClaimsOver();
    error NotModule();
    error ForgePaused();
    error NothingBurned();
    error BadDiscount();

    // --------------------------------------------------------------- events

    event Mined(
        address indexed miner,
        uint256 indexed tokenId,
        uint256 nonce,
        bytes32 work,
        uint8 bits,
        uint256 paid
    );
    event Claimed(address indexed miner, uint256 indexed tokenId, bytes32 codeHash);
    event CodeAdded(bytes32 indexed codeHash);
    event Regulated(uint8 loadAdjust, uint256 avgPaceS);
    event BaseURIUpdated(string uri);
    event PauseSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event Withdrawn(address indexed to, uint256 amount);
    event ModuleSet(address indexed module, bool allowed);
    event Burned(address indexed by, uint256 indexed tokenId);
    event Forged(address indexed to, uint256 indexed tokenId, bytes32 seed);
    event ForgePauseSet(bool paused);
    event StakingDiscountSet(address indexed wallet, uint16 milliBits);

    // ------------------------------------------------------------ constants

    uint256 public constant EPOCH_BITS = 2; // +2 difficulty bits per wave
    uint256 public constant STREAK_STEP = 2; // +2 difficulty bits per streak mint
    // v3.3: flat streak-cooldown schedule (seconds) — 5 min per streak level, capped at 25 min.
    uint256 public constant COOLDOWN_STEP_S = 300; // wait added per streak level (5 minutes)
    uint256 public constant COOLDOWN_MAX_S = 1500; // schedule cap = streak level 5 (25 minutes)
    uint256 public constant COOLDOWN_MAX_LEVEL = COOLDOWN_MAX_S / COOLDOWN_STEP_S; // levels 1..5 map onto the schedule
    uint256 public constant LOCK_WAVES = 5; // free tokens lock until wave >= 5
    uint8 public constant LOAD_ADJ_MAX = 64; // regulator ceiling
    uint256 public constant PACE_FAST_PCT = 80; // faster than 0.8x target → tighten
    uint256 public constant PACE_SLOW_PCT = 120; // slower than 1.2x target → loosen
    uint256 public constant PACE_STEP_UP = 2; // v3.3: fast window → +2 difficulty bits
    uint256 public constant PACE_STEP_DOWN = 1; // v3.3: slow window → −1 difficulty bit

    /// @notice Forged token ids live in a separate namespace: FORGE_ID_BASE + totalForged.
    uint256 public constant FORGE_ID_BASE = 10_000_000;
    /// @notice Max PoW difficulty a staking module may waive, in MILLI-BITS (thousandths of a
    ///         bit). 6000 = 6 bits. Fractional values (e.g. 500 = 0.5 bit) enable a tenuous boost.
    uint16 public constant MAX_DISCOUNT_MILLI = 6000;
    /// @notice Milli-bits per whole difficulty bit.
    uint256 public constant MILLI_PER_BIT = 1000;
    /// @notice Fractional-bits fixed-point base (2^(tenths/10) is stored ×FRAC_BASE).
    uint256 public constant FRAC_BASE = 1_000_000;
    /// @notice Blocks between a mint and the block whose hash seeds its art (post-inclusion entropy).
    uint256 public constant SEED_DELAY_BLOCKS = 2;
    /// @notice Absolute difficulty ceiling (leading zero bits of a uint256 keccak output).
    uint256 public constant MAX_BITS = 250;
    /// @notice Absolute ceiling on the optional mint fee (1000 bps = 10%).
    uint256 public constant MAX_MINT_FEE_BPS = 1000;

    // ----------------------------------------------------------- immutables

    uint256 public immutable maxSupply;
    uint256 public immutable freeClaims;
    uint256 public immutable epochSize;
    uint256 public immutable priceStart;
    uint8 public immutable baseBits;
    uint96 public immutable royaltyBps; // e.g. 500 = 5%
    /// @notice Optional mint fee, basis points on top of the price (e.g. 250 = 2.5%). 0 = none.
    uint256 public immutable mintFeeBps;
    uint256 public immutable regWindow; // mints per pace-regulator window
    uint256 public immutable paceTargetS; // target seconds per mint
    /// @notice Proceeds + royalty receiver. Pinned at deployment (immutable by design).
    address public immutable treasury;

    // --------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    string public baseURI;
    bool public mintPaused;

    uint256 public totalMinted; // free claims + paid mints (forged tokens are NOT counted here)
    uint256 public totalPaid; // cumulative native value paid by minters (not a balance)
    uint256 public totalFees; // cumulative mint fees collected, subset of totalPaid
    uint256 public totalWithdrawn; // cumulative native value swept to the treasury
    uint256 public paidMinted; // paid mints only (drives price/waves)

    mapping(address => uint256) public mintCount; // per-wallet paid mints
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(uint256 => bytes32) public seedOf; // winning work hash (or claim hash); art seed = keccak(seedOf ‖ blockhash(mintBlockOf+2))
    mapping(uint256 => uint256) public nonceOf; // winning nonce (audit)
    mapping(uint256 => uint64) public mintBlockOf; // v3.4: block of mint → post-inclusion entropy (0 for claim tokens)

    // streak: per-wallet escalating penalty inside a flat streak-level cooldown (v3.3)
    mapping(address => uint256) public streakBits;
    mapping(address => uint256) public lastMintAt;

    // load regulator
    uint8 public loadAdjust;
    uint256 public regWindowMints;
    uint256 public regWindowStartTs;

    // free claims
    mapping(bytes32 => uint8) public codeStatus; // 0 unknown, 1 available, 2 used
    uint256 public claimedCount;
    mapping(uint256 => bool) public isFreeToken;
    bytes32[] private _codes; // every hash that ever became available (unique)

    // ------------------------------------------------------- v3.1 additions

    mapping(address => bool) public authorizedModules; // Safe-managed module registry
    uint256 public totalBurned; // monotone up; funds the forge quota
    uint256 public totalForged; // monotone up; must stay <= totalBurned
    bool public forgePaused; // pauses ONLY forgeMint (burn/mint unaffected)
    mapping(address => uint16) public stakingDiscountMilli; // v3.4: PoW-boost per wallet, MILLI-BITS (module-set)

    // ----------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    modifier onlyModule() {
        if (!authorizedModules[msg.sender]) revert NotModule();
        _;
    }

    // --------------------------------------------------------- constructor

    constructor(
        string memory name_,
        string memory symbol_,
        address treasury_,
        string memory baseURI_,
        uint8 baseBits_,
        uint256 priceStart_,
        uint256 epochSize_,
        uint256 freeClaims_,
        uint256 maxSupply_,
        uint96 royaltyBps_,
        uint256 mintFeeBps_,
        uint256 regWindow_,
        uint256 paceTargetS_
    ) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        if (royaltyBps_ > 1000) revert BadConfig();
        if (mintFeeBps_ > MAX_MINT_FEE_BPS) revert BadConfig();
        if (baseBits_ < 21 || baseBits_ >= 250) revert BadConfig(); // v3.4: ≥21 keeps target math in range
        if (priceStart_ == 0) revert BadConfig();
        if (epochSize_ < 2) revert BadConfig();
        if (freeClaims_ < 1) revert BadConfig();
        if (maxSupply_ < freeClaims_ + 2 * epochSize_) revert BadConfig();
        if (maxSupply_ >= FORGE_ID_BASE) revert BadConfig(); // L-01: id-namespace collision guard
        if (regWindow_ < 2) revert BadConfig();
        if (paceTargetS_ < 1) revert BadConfig();

        name = name_;
        symbol = symbol_;
        treasury = treasury_;
        baseURI = baseURI_;
        baseBits = baseBits_;
        priceStart = priceStart_;
        epochSize = epochSize_;
        freeClaims = freeClaims_;
        maxSupply = maxSupply_;
        royaltyBps = royaltyBps_;
        mintFeeBps = mintFeeBps_;
        regWindow = regWindow_;
        paceTargetS = paceTargetS_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------ economics

    /// @notice Paid supply = maxSupply − freeClaims.
    function paidSupply() public view returns (uint256) {
        return maxSupply - freeClaims;
    }

    /// @notice 0-based price epoch. Frozen at the last wave once paid supply is exhausted.
    function epochIndex() public view returns (uint256) {
        uint256 paid = paidMinted;
        uint256 ps = maxSupply - freeClaims;
        if (paid >= ps) return (ps - 1) / epochSize; // freeze at the LAST real wave
        return paid / epochSize;
    }

    /// @notice 1-based wave number (difficulty / cooldown / lock all key off this).
    function currentWave() public view returns (uint256) {
        return epochIndex() + 1;
    }

    /// @notice Current mint price = priceStart × 2^epochIndex (no cap), with an explicit
    ///         overflow guard (L-02): reverts instead of silently wrapping for configs whose
    ///         ladder leaves the uint256 range (unreachable on shipped configs).
    function currentPrice() public view returns (uint256) {
        uint256 e = epochIndex();
        uint256 price = priceStart << e;
        if (price >> e != priceStart) revert BadConfig();
        return price;
    }

    /// @notice Amount a minter must send right now and the fee portion of it (v3.2).
    /// @return due total native value required by `mint()` = currentPrice() + fee.
    /// @return fee fee component = currentPrice() × mintFeeBps / 10000.
    function currentMintDue() public view returns (uint256 due, uint256 fee) {
        uint256 price = currentPrice();
        fee = price * mintFeeBps / 10000;
        due = price + fee;
    }

    /// @notice Circulating tokens = minted (paid + claims) − burned + forged. Never exceeds maxSupply.
    /// @dev Written as (minted + forged) − burned to avoid intermediate underflow when a
    ///      forged token is burned before its slot is re-filled.
    function circulating() public view returns (uint256) {
        return (totalMinted + totalForged) - totalBurned;
    }

    // ----------------------------------------------------------------- pow

    /// @notice The exact preimage hash a miner must grind.
    function workFor(address miner, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce));
    }

    /// @notice Cooldown (seconds) before a wallet's streak resets — v3.3 FLAT schedule by
    ///         streak level: 5/10/15/20/25 min for levels 1..5, capped at 25 min at level 5+.
    ///         No wave scaling (supersedes the old `COOLDOWN_BASE × wave`).
    function cooldown(address miner) public view returns (uint256) {
        uint256 level = streakBits[miner] / STREAK_STEP;
        if (level > COOLDOWN_MAX_LEVEL) level = COOLDOWN_MAX_LEVEL;
        return COOLDOWN_STEP_S * level;
    }

    /// @notice True while a wallet's streak penalty is still "hot".
    function streakActive(address miner) public view returns (bool) {
        return streakBits[miner] > 0 && block.timestamp - lastMintAt[miner] < cooldown(miner);
    }

    /// @notice Effective difficulty for a miner in MILLI-BITS (thousandths of a bit, v3.4).
    /// @dev base difficulty (bits) ×1000, minus the wallet's staking discount (which may be
    ///      fractional), floored at the wave-1 floor `baseBits`. Capped at MAX_BITS.
    function requiredMilli(address miner) public view returns (uint256) {
        uint256 bits = uint256(baseBits) + EPOCH_BITS * epochIndex() + uint256(loadAdjust);
        if (streakActive(miner)) bits += streakBits[miner];
        if (bits > MAX_BITS) bits = MAX_BITS;

        uint256 milli = bits * MILLI_PER_BIT;
        uint256 d = uint256(stakingDiscountMilli[miner]);
        if (d >= milli) milli = 0;
        else milli -= d;

        uint256 floorMilli = uint256(baseBits) * MILLI_PER_BIT;
        if (milli < floorMilli) milli = floorMilli; // never below the wave-1 floor
        return milli;
    }

    /// @notice Integer difficulty (leading zero bits) — display / back-compat: ceil of requiredMilli.
    function requiredBits(address miner) public view returns (uint8) {
        uint256 milli = requiredMilli(miner);
        uint256 bits = (milli + MILLI_PER_BIT - 1) / MILLI_PER_BIT;
        return uint8(bits > MAX_BITS ? MAX_BITS : bits);
    }

    /// @notice The work target a miner must beat: valid iff `uint256(workFor(miner,nonce)) < targetFor(miner)`.
    /// @dev target = 2^(256 − (intPart + tenths/10)). A fractional (tenths) difficulty SHRINKS the
    ///      target (harder): target = 2^(256 − intPart) / 2^(tenths/10). WAVE-1 FLOOR: requiredMilli is
    ///      already floored at baseBits, so the target can never exceed 2^(256 − baseBits). The
    ///      constructor requires baseBits ≥ 21 to keep `(1 << (256 − intPart)) * FRAC_BASE` in range.
    function targetFor(address miner) public view returns (uint256) {
        uint256 milli = requiredMilli(miner);
        uint256 intPart = milli / MILLI_PER_BIT;
        uint256 tenths = (milli % MILLI_PER_BIT) / 100; // 0..9
        uint256 t = uint256(1) << (256 - intPart);
        if (tenths > 0) {
            t = (t * FRAC_BASE) / _fracMul(tenths);
        }
        return t;
    }

    /// @dev 2^(tenths/10) × FRAC_BASE, tenths ∈ 0..9.
    function _fracMul(uint256 tenths) internal pure returns (uint256) {
        if (tenths == 1) return 1_071_773;
        if (tenths == 2) return 1_148_698;
        if (tenths == 3) return 1_231_144;
        if (tenths == 4) return 1_319_508;
        if (tenths == 5) return 1_414_214;
        if (tenths == 6) return 1_515_717;
        if (tenths == 7) return 1_624_505;
        if (tenths == 8) return 1_741_101;
        if (tenths == 9) return 1_866_066;
        return FRAC_BASE; // tenths == 0
    }

    // ---------------------------------------------------------------- mint

    /// @notice Mine an NFT: grind `nonce` until workFor(msg.sender, nonce) meets requiredBits.
    /// @dev Send exactly currentMintDue() native USDC wei (price + optional mint fee).
    function mint(uint256 nonce) external payable {
        if (mintPaused) revert MintPaused();
        if (paidMinted >= maxSupply - freeClaims) revert SoldOut();

        uint256 price = currentPrice();
        uint256 fee = price * mintFeeBps / 10000;
        uint256 due = price + fee;
        if (msg.value != due) revert WrongPayment(msg.value, due);

        if (nonceUsed[msg.sender][nonce]) revert NonceUsed();

        // Difficulty check uses the CURRENT streak (before this mint's increment).
        // v3.4: work must beat a fractional target (staking discount is in milli-bits).
        bytes32 work = workFor(msg.sender, nonce);
        uint256 target = targetFor(msg.sender);
        if (uint256(work) >= target) revert BelowTarget(uint256(work), target);
        uint256 gotBits = _leadingZeroBits(work);

        // ----------------------------------------------------- effects (CEI)
        nonceUsed[msg.sender][nonce] = true;
        mintCount[msg.sender] += 1;

        // Streak update: reset first if the previous streak expired, then extend.
        if (streakBits[msg.sender] > 0 && block.timestamp - lastMintAt[msg.sender] >= cooldown(msg.sender)) {
            streakBits[msg.sender] = 0;
        }
        streakBits[msg.sender] += STREAK_STEP;
        lastMintAt[msg.sender] = block.timestamp;

        paidMinted += 1;
        uint256 tokenId = ++totalMinted;
        seedOf[tokenId] = work;
        nonceOf[tokenId] = nonce;
        mintBlockOf[tokenId] = uint64(block.number); // v3.4 post-inclusion entropy
        totalPaid += msg.value;
        totalFees += fee;

        _mint(msg.sender, tokenId);

        _regulate();

        emit Mined(msg.sender, tokenId, nonce, work, uint8(gotBits > 255 ? 255 : gotBits), msg.value);
    }

    // ---------------------------------------------------------- free claims

    /// @notice Pre-load claim codes (owner). Each hash becomes claimable exactly once.
    function addCodes(bytes32[] calldata hashes) external onlyOwner {
        for (uint256 i; i < hashes.length; ++i) {
            bytes32 h = hashes[i];
            if (codeStatus[h] == 0) {
                codeStatus[h] = 1;
                _codes.push(h);
                emit CodeAdded(h);
            }
        }
    }

    /// @notice Redeem a free claim code. No payment, no PoW.
    function claim(bytes32 code) external payable {
        if (mintPaused) revert MintPaused();
        if (msg.value != 0) revert WrongPayment(msg.value, 0);
        if (claimedCount >= freeClaims) revert ClaimsOver();

        bytes32 h = keccak256(abi.encodePacked(code));
        if (codeStatus[h] != 1) revert InvalidCode();

        codeStatus[h] = 2;
        claimedCount += 1;

        uint256 tokenId = ++totalMinted;
        isFreeToken[tokenId] = true;
        seedOf[tokenId] = keccak256(abi.encodePacked("claim", block.chainid, address(this), msg.sender, code));

        _mint(msg.sender, tokenId);
        emit Claimed(msg.sender, tokenId, h);
    }

    /// @notice Number of codes still claimable.
    function codesAvailable() public view returns (uint256 c) {
        for (uint256 i; i < _codes.length; ++i) {
            if (codeStatus[_codes[i]] == 1) ++c;
        }
    }

    /// @notice Free claims remaining.
    function claimsLeft() public view returns (uint256) {
        return freeClaims - claimedCount;
    }

    // ------------------------------------------------- burn & forge (v3.1)

    /// @notice Burn a token you own (or are approved for). Allowed even while locked
    ///         (lock restricts transfers, not deflation) and while mint is paused.
    /// @dev Funds the forge quota: `totalForged < totalBurned` is required to forge.
    function burn(uint256 tokenId) external {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert NoToken();
        if (
            msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]
                && msg.sender != _tokenApprovals[tokenId]
        ) revert NotAuthorized();

        _burn(tokenId);
        totalBurned += 1;
        emit Burned(msg.sender, tokenId);
    }

    /// @notice Mint a forged token (crafting result). Module-only; strictly quota-bound:
    ///         every forged token must be covered by a prior burn.
    /// @dev The caller (CraftingController satellite) is responsible for the commit-reveal
    ///      entropy and slot-inheritance rules; the core only enforces the quota + namespace.
    function forgeMint(address to, bytes32 seed) external onlyModule {
        if (forgePaused) revert ForgePaused();
        if (totalForged >= totalBurned) revert NothingBurned();

        uint256 tokenId = FORGE_ID_BASE + totalForged;
        totalForged += 1;
        seedOf[tokenId] = seed;
        mintBlockOf[tokenId] = uint64(block.number); // v3.4: forged children also get post-inclusion entropy

        _mint(to, tokenId); // reverts on zero address / duplicate id
        emit Forged(to, tokenId, seed);
    }

    /// @notice Grant/revoke a module (CraftingController, StakingVault, ...). Owner = Safe.
    function setModule(address module, bool allowed) external onlyOwner {
        if (allowed && module == address(0)) revert ZeroAddress();
        authorizedModules[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    /// @notice Pause ONLY the forge path. Burn and normal mint are unaffected.
    function setForgePaused(bool paused) external onlyOwner {
        forgePaused = paused;
        emit ForgePauseSet(paused);
    }

    /// @notice PoW-boost: the staking vault grants a wallet up to MAX_DISCOUNT_MILLI off its
    ///         requiredBits (floor: baseBits). Module-only; v3.4 accepts MILLI-BITS so lock-time
    ///         boosts can be fractional (e.g. 500 = 0.5 bit). 0 clears the discount.
    function setStakingDiscount(address wallet, uint16 milliBits) external onlyModule {
        if (milliBits > MAX_DISCOUNT_MILLI) revert BadDiscount();
        stakingDiscountMilli[wallet] = milliBits;
        emit StakingDiscountSet(wallet, milliBits);
    }

    // ---------------------------------------------------- free-token lock

    /// @dev Free tokens are non-transferable until wave >= LOCK_WAVES. safeTransferFrom
    ///      funnels through this override, so both transfer paths are covered.
    function transferFrom(address from, address to, uint256 id) public override {
        if (isFreeToken[id] && currentWave() < LOCK_WAVES) revert FreeTokenLocked(id);
        super.transferFrom(from, to, id);
    }

    // -------------------------------------------------------------- erc-2981

    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        return (treasury, (salePrice * royaltyBps) / 10_000);
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == 0x2a55205a // ERC-2981
            || super.supportsInterface(interfaceId);
    }

    // -------------------------------------------------------------- metadata

    function tokenURI(uint256 id) public view returns (string memory) {
        ownerOf(id); // reverts for nonexistent tokens
        return string.concat(baseURI, _toString(id));
    }

    // --------------------------------------------------------------- admin

    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI = uri;
        emit BaseURIUpdated(uri);
    }

    function setPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit PauseSet(paused);
    }

    // NOTE: treasury is immutable by design — proceeds and royalties are pinned to the
    // deploy-time address. No setTreasury() exists.

    /// @notice Sends the contract's whole balance to the immutable treasury (permissionless).
    /// @dev `address(this).balance` can exceed `totalPaid - totalWithdrawn` if native USDC
    ///      is force-sent to the contract; any such surplus is also swept to treasury.
    function withdraw() external {
        uint256 amount = address(this).balance;
        (bool ok,) = payable(treasury).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        totalWithdrawn += amount;
        emit Withdrawn(treasury, amount);
    }

    /// @notice Step 1: nominate a new owner (audit M-03). The nominee must call acceptOwnership().
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2: accept ownership (callable only by the pending owner, e.g. the Safe).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwnerRole();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------- internals

    /// @dev Pace regulator: tightens by PACE_STEP_UP bits when mints are faster than
    ///      0.8×target, loosens by PACE_STEP_DOWN bit when slower than 1.2×target, holds inside
    ///      the dead zone. Floor is implicit (0); the ceiling is LOAD_ADJ_MAX.
    function _regulate() internal {
        if (regWindowMints == 0) {
            regWindowStartTs = block.timestamp;
        }
        regWindowMints += 1;

        if (regWindowMints >= regWindow) {
            uint256 elapsed = block.timestamp - regWindowStartTs;
            uint256 avg = elapsed / regWindow;

            if (avg * 100 < paceTargetS * PACE_FAST_PCT) {
                // v3.3 asymmetry: fast window tightens by +2 bits (clamped at the ceiling).
                uint256 next = uint256(loadAdjust) + PACE_STEP_UP;
                loadAdjust = next > LOAD_ADJ_MAX ? LOAD_ADJ_MAX : uint8(next);
            } else if (avg * 100 > paceTargetS * PACE_SLOW_PCT) {
                if (loadAdjust > 0) loadAdjust -= uint8(PACE_STEP_DOWN);
            }
            emit Regulated(loadAdjust, avg);
            regWindowMints = 0;
        }
    }

    /// @dev Count leading zero bits of a 32-byte hash (bitstring order, FAB-style).
    function _leadingZeroBits(bytes32 h) internal pure returns (uint256 z) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        if (x >> 128 == 0) { z += 128; } else { x >>= 128; }
        if (x >> 64 == 0) { z += 64; } else { x >>= 64; }
        if (x >> 32 == 0) { z += 32; } else { x >>= 32; }
        if (x >> 16 == 0) { z += 16; } else { x >>= 16; }
        if (x >> 8 == 0) { z += 8; } else { x >>= 8; }
        if (x >> 4 == 0) { z += 4; } else { x >>= 4; }
        if (x >> 2 == 0) { z += 2; } else { x >>= 2; }
        if (x >> 1 == 0) { z += 1; }
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
