// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Minimal} from "./ERC721Minimal.sol";

/// @title PowMintNFT — proof-of-work minted NFT collection (Arc Chain, USDC gas).
///
/// Mint model (FAB-style, hybrid economy):
///   work  = keccak256(chainid ‖ address(this) ‖ miner ‖ nonce)
///   valid ⟺ leadingZeroBits(work) ≥ requiredBits(miner)
///   requiredBits(miner) = baseBits + escalationBits × mintsByWallet(miner)
///
/// Economy:
///   - first `freeSupply` tokens are free (gas only),
///   - afterwards price = priceStart × 2^epoch, epoch = (minted − freeSupply) / epochSize,
///     capped at `maxDoublings` doublings.
///
/// Art pipeline (hybrid): the winning hash is stored on-chain as `seedOf(tokenId)`.
/// Off-chain renderers derive deterministic traits/art from (tokenId, seed).
contract PowMintNFT is ERC721Minimal {
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

    // --------------------------------------------------------------- events

    event Mined(
        address indexed miner,
        uint256 indexed tokenId,
        uint256 nonce,
        bytes32 work,
        uint8 bits,
        uint256 paid
    );
    event BaseURIUpdated(string uri);
    event PauseSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Withdrawn(address indexed to, uint256 amount);

    // ----------------------------------------------------------- immutables

    uint256 public immutable maxSupply;
    uint256 public immutable freeSupply;
    uint256 public immutable epochSize;
    uint256 public immutable priceStart;
    uint8 public immutable maxDoublings;
    uint8 public immutable baseBits;
    uint8 public immutable escalationBits;
    uint96 public immutable royaltyBps; // e.g. 500 = 5%

    // --------------------------------------------------------------- state

    address public owner;
    /// @notice Proceeds + royalty receiver. Pinned at deployment (immutable by design).
    address public immutable treasury;
    string public baseURI;
    bool public mintPaused;

    uint256 public totalMinted;
    uint256 public totalPaid;

    mapping(address => uint256) public mintCount; // per-wallet mints (escalation)
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(uint256 => bytes32) public seedOf; // winning work hash → art seed
    mapping(uint256 => uint256) public nonceOf; // winning nonce (audit)

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
        uint8 escalationBits_,
        uint256 freeSupply_,
        uint256 epochSize_,
        uint256 maxSupply_,
        uint256 priceStart_,
        uint96 royaltyBps_,
        uint8 maxDoublings_
    ) {
        if (maxSupply_ == 0 || epochSize_ == 0) revert BadConfig();
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        if (freeSupply_ > maxSupply_) revert BadConfig();
        if (royaltyBps_ > 1000 || baseBits_ == 0 || baseBits_ >= 250) revert BadConfig();
        if (maxDoublings_ > 64) revert BadConfig();
        if (freeSupply_ < maxSupply_ && priceStart_ == 0) revert BadConfig();
        // Audit M-01: escalation is fixed at +2 bits per wallet mint.
        if (escalationBits_ != 2) revert BadConfig();
        // Audit H-01: priceStart * 2^maxDoublings must fit in uint256.
        if (maxDoublings_ != 0 && priceStart_ > type(uint256).max >> maxDoublings_) revert BadConfig();

        name = name_;
        symbol = symbol_;
        treasury = treasury_;
        baseURI = baseURI_;
        baseBits = baseBits_;
        escalationBits = escalationBits_;
        freeSupply = freeSupply_;
        epochSize = epochSize_;
        maxSupply = maxSupply_;
        priceStart = priceStart_;
        royaltyBps = royaltyBps_;
        maxDoublings = maxDoublings_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ----------------------------------------------------------------- pow

    /// @notice The exact preimage hash a miner must grind.
    function workFor(address miner, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce));
    }

    /// @notice Current difficulty (in leading zero bits) for a given miner.
    function requiredBits(address miner) public view returns (uint8) {
        uint256 bits = uint256(baseBits) + uint256(escalationBits) * mintCount[miner];
        return uint8(bits > 250 ? 250 : bits);
    }

    /// @notice Current mint price in native USDC wei (18 decimals). Zero during the free wave.
    function currentPrice() public view returns (uint256) {
        if (totalMinted < freeSupply) return 0;
        uint256 step = (totalMinted - freeSupply) / epochSize;
        if (step > maxDoublings) step = maxDoublings;
        return priceStart * (1 << step);
    }

    /// @notice Current epoch index (0 = free wave, then price epochs).
    function currentEpoch() public view returns (uint256) {
        if (totalMinted < freeSupply) return 0;
        return 1 + (totalMinted - freeSupply) / epochSize;
    }

    // ---------------------------------------------------------------- mint

    /// @notice Mine an NFT: grind `nonce` off-chain until `workFor(msg.sender, nonce)`
    ///         has at least `requiredBits(msg.sender)` leading zero bits.
    /// @dev Send `currentPrice()` wei of native USDC (0 during the free wave).
    function mint(uint256 nonce) external payable {
        if (mintPaused) revert MintPaused();
        if (totalMinted >= maxSupply) revert SoldOut();

        uint256 price = currentPrice();
        if (msg.value != price) revert WrongPayment(msg.value, price);

        if (nonceUsed[msg.sender][nonce]) revert NonceUsed();

        uint8 need = requiredBits(msg.sender);
        bytes32 work = workFor(msg.sender, nonce);
        uint256 gotBits = _leadingZeroBits(work);
        if (gotBits < need) {
            revert BelowFloor(uint8(gotBits > 255 ? 255 : gotBits), need);
        }

        nonceUsed[msg.sender][nonce] = true;
        mintCount[msg.sender] += 1;
        uint256 tokenId = ++totalMinted;
        seedOf[tokenId] = work;
        nonceOf[tokenId] = nonce;
        totalPaid += msg.value;

        _mint(msg.sender, tokenId);
        emit Mined(msg.sender, tokenId, nonce, work, uint8(gotBits > 255 ? 255 : gotBits), msg.value);
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
    // deploy-time address (owner decision, 16.09.2026). No setTreasury() exists.

    function withdraw() external {
        uint256 amount = address(this).balance;
        (bool ok,) = payable(treasury).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(treasury, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -------------------------------------------------------------- internals

    /// @dev Count leading zero bits of a 32-byte hash (bitstring order, same as FAB-style checks).
    ///      clz(0) = 256 is represented, but a keccak output is never zero in practice.
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
