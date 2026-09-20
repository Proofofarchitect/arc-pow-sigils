// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Minimal} from "./ERC721Minimal.sol";

/// @title PowMintNFTv3 — "Proof of Architect" (Arc Chain, USDC gas).
///
/// Mint model (hashcats-style hybrid economy):
///   work = keccak256(chainid ‖ address(this) ‖ miner ‖ nonce)
///   valid ⟺ leadingZeroBits(work) ≥ requiredBits(miner)   (capped at 250)
///
/// Three difficulty layers:
///   1. wave base     : baseBits + EPOCH_BITS * epochIndex  (price doubles per wave),
///   2. load regulator: +loadAdjust  (auto-tightens/loosens to hit a pace target),
///   3. per-wallet    : +streakBits within a wave-scaled cooldown window.
///
/// Economy:
///   - `freeClaims` tokens are claimable with a code (no PoW), 42 influencer slots,
///   - paid price = priceStart × 2^epochIndex, epochIndex = paidMinted / epochSize,
///   - free tokens are non-transferable until wave >= LOCK_WAVES.
contract PowMintNFTv3 is ERC721Minimal {
    // --------------------------------------------------------------- errors

    error BelowFloor(uint8 got, uint8 need);
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

    // ------------------------------------------------------------ constants

    uint256 public constant EPOCH_BITS = 2; // +2 difficulty bits per wave
    uint256 public constant STREAK_STEP = 2; // +2 difficulty bits per streak mint
    uint256 public constant COOLDOWN_BASE = 60; // cooldown = COOLDOWN_BASE * wave (seconds)
    uint256 public constant LOCK_WAVES = 5; // free tokens lock until wave >= 5
    uint8 public constant LOAD_ADJ_MAX = 64; // regulator ceiling
    uint256 public constant PACE_FAST_PCT = 80; // faster than 0.8x target → tighten
    uint256 public constant PACE_SLOW_PCT = 120; // slower than 1.2x target → loosen

    // ----------------------------------------------------------- immutables

    uint256 public immutable maxSupply;
    uint256 public immutable freeClaims;
    uint256 public immutable epochSize;
    uint256 public immutable priceStart;
    uint8 public immutable baseBits;
    uint96 public immutable royaltyBps; // e.g. 500 = 5%
    uint256 public immutable regWindow; // mints per pace-regulator window
    uint256 public immutable paceTargetS; // target seconds per mint
    /// @notice Proceeds + royalty receiver. Pinned at deployment (immutable by design).
    address public immutable treasury;

    // --------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    string public baseURI;
    bool public mintPaused;

    uint256 public totalMinted; // free claims + paid mints
    uint256 public totalPaid; // cumulative native value paid by minters (not a balance)
    uint256 public totalWithdrawn; // cumulative native value swept to the treasury
    uint256 public paidMinted; // paid mints only (drives price/waves)

    mapping(address => uint256) public mintCount; // per-wallet paid mints
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(uint256 => bytes32) public seedOf; // winning work hash (or claim hash) → art seed
    mapping(uint256 => uint256) public nonceOf; // winning nonce (audit)

    // streak: per-wallet escalating penalty inside a wave-scaled cooldown
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

    // ----------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
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
        uint256 regWindow_,
        uint256 paceTargetS_
    ) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        if (royaltyBps_ > 1000) revert BadConfig();
        if (baseBits_ < 1 || baseBits_ >= 250) revert BadConfig();
        if (priceStart_ == 0) revert BadConfig();
        if (epochSize_ < 2) revert BadConfig();
        if (freeClaims_ < 1) revert BadConfig();
        if (maxSupply_ < freeClaims_ + 2 * epochSize_) revert BadConfig();
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

    /// @notice Current mint price = priceStart × 2^epochIndex (no cap).
    function currentPrice() public view returns (uint256) {
        return priceStart << epochIndex();
    }

    // ----------------------------------------------------------------- pow

    /// @notice The exact preimage hash a miner must grind.
    function workFor(address miner, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce));
    }

    /// @notice Cooldown (seconds) for the current wave; grows linearly with the wave.
    function cooldown(address) public view returns (uint256) {
        return COOLDOWN_BASE * currentWave();
    }

    /// @notice True while a wallet's streak penalty is still "hot".
    function streakActive(address miner) public view returns (bool) {
        return streakBits[miner] > 0 && block.timestamp - lastMintAt[miner] < cooldown(miner);
    }

    /// @notice Current difficulty (leading zero bits) for a given miner.
    /// @dev baseBits + 2*waveIndex + loadAdjust + (active streak), capped at 250.
    ///      clz(0) = 256 is representable but a keccak output is never zero in practice.
    function requiredBits(address miner) public view returns (uint8) {
        uint256 bits = uint256(baseBits) + EPOCH_BITS * epochIndex() + uint256(loadAdjust);
        if (streakActive(miner)) bits += streakBits[miner];
        return uint8(bits > 250 ? 250 : bits);
    }

    // ---------------------------------------------------------------- mint

    /// @notice Mine an NFT: grind `nonce` until workFor(msg.sender, nonce) meets requiredBits.
    /// @dev Send exactly currentPrice() native USDC wei.
    function mint(uint256 nonce) external payable {
        if (mintPaused) revert MintPaused();
        if (paidMinted >= maxSupply - freeClaims) revert SoldOut();

        uint256 price = currentPrice();
        if (msg.value != price) revert WrongPayment(msg.value, price);

        if (nonceUsed[msg.sender][nonce]) revert NonceUsed();

        // Difficulty check uses the CURRENT streak (before this mint's increment).
        uint8 need = requiredBits(msg.sender);
        bytes32 work = workFor(msg.sender, nonce);
        uint256 gotBits = _leadingZeroBits(work);
        if (gotBits < need) revert BelowFloor(uint8(gotBits > 255 ? 255 : gotBits), need);

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
        totalPaid += msg.value;

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

    /// @dev Pace regulator: tightens when mints are faster than 0.8×target, loosens when
    ///      slower than 1.2×target, holds inside the dead zone. Floor is implicit (0).
    function _regulate() internal {
        if (regWindowMints == 0) {
            regWindowStartTs = block.timestamp;
        }
        regWindowMints += 1;

        if (regWindowMints >= regWindow) {
            uint256 elapsed = block.timestamp - regWindowStartTs;
            uint256 avg = elapsed / regWindow;

            if (avg * 100 < paceTargetS * PACE_FAST_PCT) {
                if (loadAdjust < LOAD_ADJ_MAX) loadAdjust += 1;
            } else if (avg * 100 > paceTargetS * PACE_SLOW_PCT) {
                if (loadAdjust > 0) loadAdjust -= 1;
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
