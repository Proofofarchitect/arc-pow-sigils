// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Hook surface the registry calls on the staking vault after a tier update. The vault
///      is expected to look up the card's stake and (if staked) push the wallet's fresh
///      aggregate weight into `StakeRewards`. Declared here (rather than imported) so the
///      registry compiles independently of the vault's v1.1 delta.
interface IStakingVaultLike {
    function pokeIfStaked(bytes32 cardKey) external;
}

/// @title RarityRegistry v1.1 — EIP-712 card-rarity attestations (economy v1.1 spec §1).
///
/// The oracle (an off-chain signing key, ops now → Safe later) attests a rarity tier for a
/// card key `bytes32(uint256(tokenId))`. A valid attestation stores `tierOf[cardKey]` and
/// bumps the per-key replay nonce. If a staking vault is wired in, the registry pokes it so
/// staked cards immediately pick up their new rarity weight.
///
/// Frozen points (spec §1):
///   - 2-step ownership (owner / pendingOwner), like the core.
///   - EIP-712 domain {name:"ProofOfArchitect", version:"1", chainId, verifyingContract}.
///   - struct RarityAttestation(bytes32 cardKey, uint8 tier, uint256 nonce, uint256 deadline).
///   - manual ECDSA: ecrecover + s-malleability guard (s ≤ secp256k1n/2), v ∈ {27,28}; no OZ.
///   - checks: recovered == attester; deadline ≥ block.timestamp; nonce > lastNonce; tier ≤ 4.
///   - bps table: 10000/12000/16000/22000/30000 (BPS_DENOM = 10000).
contract RarityRegistry {
    // -------------------------------------------------------------- constants

    /// @notice Highest valid tier (Standard..Mythic = 0..4).
    uint8 public constant MAX_TIER = 4;
    /// @notice BPS denominator; bps values are multiplicative factors ×10000.
    uint16 public constant BPS_DENOM = 10000;

    /// @dev secp256k1n / 2 — upper bound on a canonical (low-s) ECDSA signature.
    uint256 internal constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice EIP-712 domain type hash.
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @notice EIP-712 `name` field hash ("ProofOfArchitect").
    bytes32 public constant NAME_HASH = keccak256("ProofOfArchitect");
    /// @notice EIP-712 `version` field hash ("1").
    bytes32 public constant VERSION_HASH = keccak256("1");
    /// @notice EIP-712 struct type hash for `RarityAttestation`.
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("RarityAttestation(bytes32 cardKey,uint8 tier,uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------- storage

    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice Oracle key allowed to sign attestations (0 ⇒ attestations disabled).
    address public attester;
    /// @notice Staking vault poked after a tier update (0 ⇒ no hook).
    address public vault;

    /// @notice cardKey (`bytes32(uint256(tokenId))`) → rarity tier 0..4.
    mapping(bytes32 => uint8) public tierOf;
    /// @notice cardKey → last accepted attestation nonce (replay guard).
    mapping(bytes32 => uint256) public lastNonce;

    // ----------------------------------------------------------------- events

    event Attested(bytes32 indexed cardKey, uint8 tier, uint256 nonce);
    event AttesterSet(address indexed attester);
    event VaultSet(address indexed vault);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotOwnerRole();
    error BadSignature();
    error Expired(uint256 deadline);
    error BadNonce(uint256 nonce);
    error BadTier(uint8 tier);

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    // ------------------------------------------------------------ constructor

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------- attestation

    /// @notice Verify an oracle attestation and record the card's rarity tier.
    /// @param cardKey card key = `bytes32(uint256(tokenId))`.
    /// @param tier rarity tier 0..4 (Standard..Mythic).
    /// @param nonce monotonic per-key nonce (must exceed the stored one).
    /// @param deadline unix timestamp after which the attestation is void.
    /// @param sig 65-byte EIP-712 signature (r ‖ s ‖ v), low-s, v ∈ {27,28}.
    function attest(bytes32 cardKey, uint8 tier, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
    {
        if (tier > MAX_TIER) revert BadTier(tier);
        if (block.timestamp > deadline) revert Expired(deadline);
        if (nonce <= lastNonce[cardKey]) revert BadNonce(nonce);

        bytes32 digest = _hashTypedData(cardKey, tier, nonce, deadline);
        address signer = _recover(digest, sig);
        // A zero attester or a zero recovery address can never authorize (disabled).
        if (signer == address(0) || signer != attester) revert BadSignature();

        lastNonce[cardKey] = nonce;
        tierOf[cardKey] = tier;
        emit Attested(cardKey, tier, nonce);

        address v = vault;
        if (v != address(0)) IStakingVaultLike(v).pokeIfStaked(cardKey);
    }

    // ------------------------------------------------------------------- views

    /// @notice Rarity multiplier (BPS) for a card key; 10000 for an un-attested card.
    function bpsOf(bytes32 cardKey) external view returns (uint16) {
        uint8 t = tierOf[cardKey];
        if (t == 0) return 10000;
        if (t == 1) return 12000;
        if (t == 2) return 16000;
        if (t == 3) return 22000;
        return 30000; // t == 4
    }

    /// @notice EIP-712 domain separator for this chain + contract instance.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice EIP-712 digest an attester must sign for the given payload.
    function hashAttestation(bytes32 cardKey, uint8 tier, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedData(cardKey, tier, nonce, deadline);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set the oracle key allowed to sign attestations.
    function setAttester(address attester_) external onlyOwner {
        attester = attester_;
        emit AttesterSet(attester_);
    }

    /// @notice Set (or clear, with 0) the staking vault poked after a tier update.
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

    function _hashTypedData(bytes32 cardKey, uint8 tier, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, cardKey, tier, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @dev Manual ECDSA recovery with low-s + v guards (no external deps).
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > SECP256K1N_HALF) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
    }
}
