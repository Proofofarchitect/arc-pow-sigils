// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFTv3_4} from "../src/PowMintNFTv3_4.sol";
import {StakingVaultV2} from "../src/StakingVaultV2.sol";

/// @title PowMintNFTv3_4Test — v3.4 delta: post-inclusion entropy (mintBlockOf) + fractional
///        (milli-bit) staking discount, plus the StakingVaultV2 boost ladder (tier0 = no boost).
contract PowMintNFTv3_4Test is Test {
    PowMintNFTv3_4 nft;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address dave = address(0xDA7E);

    string constant BASE = "https://t/x/api/";

    // baseBits = 21 (v3.4 minimum), epochSize = 2 (=> wave 2 after two paid mints).
    function _deploy() internal returns (PowMintNFTv3_4) {
        return new PowMintNFTv3_4("POVA", "PV34", treasury, BASE, 21, 1e18, 2, 2, 40, 500, 0, 100, 60);
    }

    function setUp() public {
        nft = _deploy();
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    // ------------------------------------------------------------- helpers

    function _findNonce(address miner, uint256 target) internal view returns (uint256 nonce, bytes32 work) {
        // fixed 104-byte preimage; only the trailing nonce word is overwritten per iteration
        // (avoids unbounded memory growth that `abi.encodePacked` in a loop would cause).
        bytes memory buf = abi.encodePacked(block.chainid, address(nft), miner, uint256(0));
        uint256 ptr;
        assembly {
            ptr := add(buf, 32)
        }
        for (uint256 n = 0; n < 1e8; ++n) {
            bytes32 w;
            assembly {
                mstore(add(ptr, 72), n) // nonce occupies bytes [72,104)
                w := keccak256(ptr, 104)
            }
            if (uint256(w) < target) return (n, w);
        }
        revert("no nonce found");
    }

    function _mint(address miner) internal returns (uint256 tokenId) {
        (uint256 nonce,) = _findNonce(miner, nft.targetFor(miner));
        (uint256 due,) = nft.currentMintDue();
        vm.prank(miner);
        nft.mint{value: due}(nonce);
        return nft.totalMinted();
    }

    // ------------------------------------------------------- constructor

    function test_Constructor_RejectsLowBaseBits() public {
        vm.expectRevert(); // baseBits < 21 breaks the target math
        new PowMintNFTv3_4("POVA", "PV34", treasury, BASE, 20, 1e18, 2, 2, 40, 500, 0, 100, 60);
    }

    // ---------------------------------------------------- fractional bits

    function test_BaseTarget_NoDiscount_IsIntegerBits() public view {
        assertEq(nft.requiredMilli(alice), 21_000);
        assertEq(nft.requiredBits(alice), 21);
        assertEq(nft.targetFor(alice), uint256(1) << (256 - 21));
    }

    function test_FractionalDiscount_HalfBit_WidensTarget() public {
        // reach wave 2 (bits = 21 + 2 = 23) with two fresh mints (no streak interference)
        _mint(alice);
        _mint(bob);
        assertEq(nft.currentWave(), 2);
        assertEq(nft.requiredMilli(carol), 23_000); // fresh wallet, no discount

        // grant carol a 0.5-bit discount via a module
        nft.setModule(address(this), true);
        nft.setStakingDiscount(carol, 500);

        assertEq(nft.requiredMilli(carol), 22_500); // 23.0 − 0.5
        uint256 t = nft.targetFor(carol);
        // strictly between the 23-bit and 22-bit integer targets
        assertGt(t, uint256(1) << (256 - 23));
        assertLt(t, uint256(1) << (256 - 22));
    }

    function test_Discount_FlooredAtBaseBits() public {
        _mint(alice);
        _mint(bob);
        nft.setModule(address(this), true);
        nft.setStakingDiscount(carol, 6000); // 6 bits, way over the wave-2 headroom

        // never below the wave-1 floor: baseBits = 21
        assertEq(nft.requiredMilli(carol), 21_000);
        assertEq(nft.targetFor(carol), uint256(1) << (256 - 21));
    }

    function test_Discount_CapEnforced() public {
        nft.setModule(address(this), true);
        vm.expectRevert(); // > MAX_DISCOUNT_MILLI (6000)
        nft.setStakingDiscount(carol, 6001);
    }

    // ------------------------------------------------- post-inclusion seed

    function test_Mint_RecordsMintBlock_AndProof() public {
        uint256 id = _mint(alice);
        assertEq(id, 1);
        assertEq(nft.mintBlockOf(id), uint64(block.number)); // entropy anchor block
        assertEq(nft.requiredMilli(alice), 23_000); // alice now carries a +2-bit streak
        assertTrue(nft.seedOf(id) != bytes32(0)); // PoW proof stored
    }

    function test_Claim_HasNoEntropyAnchor() public {
        bytes32 code = bytes32("freecode");
        bytes32[] memory codes = new bytes32[](1);
        codes[0] = keccak256(abi.encodePacked(code));
        nft.addCodes(codes);
        nft.claim(code);
        // claim tokens keep a deterministic seed and carry NO entropy anchor
        assertEq(nft.mintBlockOf(1), 0);
        assertTrue(nft.seedOf(1) != bytes32(0));
    }

    // ------------------------------------------------------- vault ladder

    function test_VaultV2_Ladder_Tier0NoBoost() public {
        StakingVaultV2 vault = new StakingVaultV2(address(nft));
        assertEq(vault.milliBitsForTier(0), 0); // flexible = income only
        assertEq(vault.milliBitsForTier(1), 500);
        assertEq(vault.milliBitsForTier(2), 1500);
        assertEq(vault.milliBitsForTier(3), 3000);
        assertEq(vault.milliBitsForTier(4), 4500);
        assertEq(vault.milliBitsForTier(5), 6000);
        assertEq(vault.weightX1000(0), 1000);
        assertEq(vault.weightX1000(5), 40000);
    }

    function test_VaultV2_Stake_PushesMilliBoost_AndHardLock() public {
        StakingVaultV2 vault = new StakingVaultV2(address(nft));
        nft.setModule(address(vault), true);

        uint256 id = _mint(alice);
        vm.startPrank(alice);
        nft.approve(address(vault), id);
        vault.stake(id, 5); // 365 days
        vm.stopPrank();

        assertEq(nft.stakingDiscountMilli(alice), 6000); // tier5 → 6 bits
        // hard lock: cannot unstake before term
        vm.prank(alice);
        vm.expectRevert();
        vault.unstake(id);
    }

    function test_VaultV2_Tier0_NoBoost_UnstakeImmediate() public {
        StakingVaultV2 vault = new StakingVaultV2(address(nft));
        nft.setModule(address(vault), true);

        uint256 id = _mint(alice);
        vm.startPrank(alice);
        nft.approve(address(vault), id);
        vault.stake(id, 0); // flexible
        assertEq(nft.stakingDiscountMilli(alice), 0); // no difficulty discount
        vault.unstake(id); // allowed immediately (0-day term)
        vm.stopPrank();

        nft.setModule(address(this), true);
        assertEq(nft.stakingDiscountMilli(alice), 0);
        assertEq(nft.ownerOf(id), alice);
    }
}
