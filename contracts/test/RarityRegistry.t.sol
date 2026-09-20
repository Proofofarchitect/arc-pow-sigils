// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RarityRegistry} from "../src/RarityRegistry.sol";

/// @dev Records the registry's `pokeIfStaked` hook.
contract MockVault {
    bytes32 public lastCardKey;
    uint256 public pokeCount;

    function pokeIfStaked(bytes32 cardKey) external {
        lastCardKey = cardKey;
        pokeCount += 1;
    }
}

/// @title RarityRegistryTest — unit suite for RarityRegistry v1.1 (`economy v1.1 spec` §1).
contract RarityRegistryTest is Test {
    RarityRegistry registry;

    uint256 constant ATTESTER_PK = 0xA11CE;
    address attester = vm.addr(ATTESTER_PK);
    uint256 constant OTHER_PK = 0xB0B;

    // secp256k1 group order (for the malleability test).
    uint256 constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 constant KEY1 = bytes32(uint256(1));
    bytes32 constant KEY2 = bytes32(uint256(42));
    bytes32 constant KEY3 = bytes32(uint256(15_000));

    function setUp() public {
        vm.warp(1_000_000);
        registry = new RarityRegistry();
        registry.setAttester(attester);
    }

    // ------------------------------------------------------------- helpers

    function _sign(uint256 pk, bytes32 cardKey, uint8 tier, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = registry.hashAttestation(cardKey, tier, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ok(bytes32 cardKey, uint8 tier, uint256 nonce) internal {
        uint256 deadline = block.timestamp + 1 days;
        registry.attest(cardKey, tier, nonce, deadline, _sign(ATTESTER_PK, cardKey, tier, nonce, deadline));
    }

    // ===================================================== constructor / owner

    function test_Constructor_SetsOwner() public {
        RarityRegistry r = new RarityRegistry();
        assertEq(r.owner(), address(this));
        assertEq(r.pendingOwner(), address(0));
        assertEq(r.attester(), address(0));
        assertEq(r.vault(), address(0));
    }

    function test_DomainSeparator_MatchesEIP712() public view {
        bytes32 expect = keccak256(
            abi.encode(
                registry.DOMAIN_TYPEHASH(),
                registry.NAME_HASH(),
                registry.VERSION_HASH(),
                block.chainid,
                address(registry)
            )
        );
        assertEq(registry.domainSeparator(), expect, "domain separator");
    }

    function test_TypeHashes_ExactValues() public view {
        assertEq(
            registry.DOMAIN_TYPEHASH(),
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        );
        assertEq(registry.NAME_HASH(), keccak256("ProofOfArchitect"));
        assertEq(registry.VERSION_HASH(), keccak256("1"));
        assertEq(
            registry.ATTESTATION_TYPEHASH(),
            keccak256("RarityAttestation(bytes32 cardKey,uint8 tier,uint256 nonce,uint256 deadline)")
        );
    }

    // ===================================================== valid attestation

    function test_Attest_ValidSig_StoresTierAndNonce() public {
        assertEq(uint256(registry.tierOf(KEY1)), 0, "default tier 0");
        _ok(KEY1, 3, 111);
        assertEq(uint256(registry.tierOf(KEY1)), 3, "tier stored");
        assertEq(registry.lastNonce(KEY1), 111, "nonce stored");
    }

    function test_Attest_EmitsAttested() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(ATTESTER_PK, KEY2, 4, 7, deadline);
        vm.expectEmit(true, false, false, true, address(registry));
        emit RarityRegistry.Attested(KEY2, 4, 7);
        registry.attest(KEY2, 4, 7, deadline, sig);
    }

    function test_Attest_AllTiersAccepted() public {
        for (uint8 t; t <= 4; ++t) {
            _ok(bytes32(uint256(100 + t)), t, 1);
            assertEq(uint256(registry.tierOf(bytes32(uint256(100 + t)))), t);
        }
    }

    // ===================================================== bad signatures

    function test_Attest_WrongSigner_Reverts() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(OTHER_PK, KEY1, 2, 1, deadline);
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, sig);
    }

    function test_Attest_TamperedTier_Reverts() public {
        uint256 deadline = block.timestamp + 1 days;
        // sign tier 2, submit tier 3
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 2, 1, deadline);
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 3, 1, deadline, sig);
    }

    function test_Attest_WrongDomain_Reverts() public {
        RarityRegistry other = new RarityRegistry();
        other.setAttester(attester);

        uint256 deadline = block.timestamp + 1 days;
        // digest bound to `other`'s verifyingContract; submitting to `registry` must fail.
        bytes32 digest = other.hashAttestation(KEY1, 2, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);

        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, abi.encodePacked(r, s, v));
    }

    function test_Attest_BadSigLength_Reverts() public {
        uint256 deadline = block.timestamp + 1 days;
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, hex"00112233");
    }

    function test_Attest_HighS_Malleability_Reverts() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = registry.hashAttestation(KEY1, 2, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);

        // flip to the non-canonical twin (s' = n − s, v flipped): s' > n/2 must be rejected.
        bytes32 sHigh = bytes32(SECP256K1N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, abi.encodePacked(r, sHigh, vFlip));
    }

    // ===================================================== deadline / nonce

    function test_Attest_ExpiredDeadline_Reverts() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 2, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(RarityRegistry.Expired.selector, deadline));
        registry.attest(KEY1, 2, 1, deadline, sig);
    }

    function test_Attest_DeadlineEqualNow_OK() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 2, 1, deadline);
        registry.attest(KEY1, 2, 1, deadline, sig);
        assertEq(uint256(registry.tierOf(KEY1)), 2);
    }

    function test_Attest_NonceReplay_Reverts() public {
        _ok(KEY1, 2, 5);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 3, 5, deadline);
        vm.expectRevert(abi.encodeWithSelector(RarityRegistry.BadNonce.selector, 5));
        registry.attest(KEY1, 3, 5, deadline, sig);
    }

    function test_Attest_NonceMustIncrease_OverwritesTier() public {
        _ok(KEY1, 2, 10);
        _ok(KEY1, 4, 11); // higher nonce → accepted, tier upgraded
        assertEq(uint256(registry.tierOf(KEY1)), 4);
        assertEq(registry.lastNonce(KEY1), 11);

        // a lower nonce is rejected
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 1, 9, deadline);
        vm.expectRevert(abi.encodeWithSelector(RarityRegistry.BadNonce.selector, 9));
        registry.attest(KEY1, 1, 9, deadline, sig);
    }

    function test_Attest_TierTooHigh_Reverts() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 5, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(RarityRegistry.BadTier.selector, uint8(5)));
        registry.attest(KEY1, 5, 1, deadline, sig);
    }

    // ===================================================== bps table

    function test_BpsOf_Table() public {
        uint16[5] memory want = [uint16(10000), 12000, 16000, 22000, 30000];
        for (uint8 t; t <= 4; ++t) {
            _ok(bytes32(uint256(1000 + t)), t, 1);
            assertEq(uint256(registry.bpsOf(bytes32(uint256(1000 + t)))), uint256(want[t]), "bps");
        }
    }

    function test_BpsOf_UnattestedDefault() public view {
        assertEq(uint256(registry.bpsOf(KEY3)), 10000, "default 10000");
    }

    // ===================================================== vault hook

    function test_Hook_PokesWhenVaultSet() public {
        MockVault mock = new MockVault();
        registry.setVault(address(mock));

        _ok(KEY1, 2, 1);
        assertEq(mock.pokeCount(), 1, "poked once");
        assertEq(mock.lastCardKey(), KEY1, "key forwarded");
    }

    function test_Hook_NoPokeWhenVaultZero() public {
        // vault == 0 → attestation still succeeds, no external call.
        _ok(KEY1, 2, 1);
        assertEq(uint256(registry.tierOf(KEY1)), 2);
    }

    function test_Hook_ClearedVaultStopsPoking() public {
        MockVault mock = new MockVault();
        registry.setVault(address(mock));
        _ok(KEY1, 2, 1);
        assertEq(mock.pokeCount(), 1);

        registry.setVault(address(0));
        _ok(KEY2, 2, 1);
        assertEq(mock.pokeCount(), 1, "no further poke");
    }

    // ===================================================== attester rotation

    function test_SetAttester_RotationInvalidatesOldSig() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory oldSig = _sign(ATTESTER_PK, KEY1, 2, 1, deadline);

        address newAttester = vm.addr(OTHER_PK);
        registry.setAttester(newAttester);

        // old (former-attester) signature now invalid
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, oldSig);

        // new attester signature accepted
        bytes32 digest = registry.hashAttestation(KEY1, 2, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OTHER_PK, digest);
        registry.attest(KEY1, 2, 1, deadline, abi.encodePacked(r, s, v));
        assertEq(uint256(registry.tierOf(KEY1)), 2);
        assertEq(registry.attester(), newAttester);
    }

    function test_ZeroAttester_NoSigAccepted() public {
        registry.setAttester(address(0));
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(ATTESTER_PK, KEY1, 2, 1, deadline);
        vm.expectRevert(RarityRegistry.BadSignature.selector);
        registry.attest(KEY1, 2, 1, deadline, sig);
    }

    // ===================================================== admin

    function test_OnlyOwner_Guards() public {
        vm.startPrank(attester);
        vm.expectRevert(RarityRegistry.NotOwnerRole.selector);
        registry.setAttester(attester);
        vm.expectRevert(RarityRegistry.NotOwnerRole.selector);
        registry.setVault(address(1));
        vm.expectRevert(RarityRegistry.NotOwnerRole.selector);
        registry.transferOwnership(attester);
        vm.stopPrank();
    }

    function test_SetAttesterVault_EmitEvents() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit RarityRegistry.AttesterSet(address(0xDEAD));
        registry.setAttester(address(0xDEAD));

        vm.expectEmit(true, false, false, true, address(registry));
        emit RarityRegistry.VaultSet(address(0xBEEF));
        registry.setVault(address(0xBEEF));
    }

    function test_Ownership_TwoStep() public {
        registry.transferOwnership(address(0xC0FFEE));
        assertEq(registry.owner(), address(this), "not yet");
        assertEq(registry.pendingOwner(), address(0xC0FFEE), "nominated");

        vm.expectRevert(RarityRegistry.NotOwnerRole.selector);
        vm.prank(attester);
        registry.acceptOwnership();

        vm.prank(address(0xC0FFEE));
        registry.acceptOwnership();
        assertEq(registry.owner(), address(0xC0FFEE), "accepted");
        assertEq(registry.pendingOwner(), address(0), "cleared");
    }
}
