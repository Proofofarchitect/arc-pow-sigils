// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFTv3_4} from "../src/PowMintNFTv3_4.sol";
import {CraftingControllerV2} from "../src/CraftingControllerV2.sol";

/// @title CraftingControllerV2Test — single-step crafting (no commit/reveal/refund).
contract CraftingControllerV2Test is Test {
    PowMintNFTv3_4 nft;
    CraftingControllerV2 craft;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    string constant BASE = "https://t/x/api/";
    uint256 constant CRAFT_FEE = 5 * 10 ** 18;

    uint256 private _cursor;

    function setUp() public {
        nft = new PowMintNFTv3_4("POVA", "PV34", treasury, BASE, 21, 1e18, 2, 2, 40, 500, 0, 100, 60);
        craft = new CraftingControllerV2(address(nft));
        nft.setModule(address(craft), true);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function _findNonce(address miner, uint256 target) internal returns (uint256 nonce) {
        bytes memory buf = abi.encodePacked(block.chainid, address(nft), miner, uint256(0));
        uint256 ptr;
        assembly {
            ptr := add(buf, 32)
        }
        for (uint256 n = _cursor; n < _cursor + 1e8; ++n) {
            bytes32 w;
            assembly {
                mstore(add(ptr, 72), n)
                w := keccak256(ptr, 104)
            }
            if (uint256(w) < target) {
                _cursor = n + 1; // never reuse a nonce for the same miner
                return n;
            }
        }
        revert("no nonce found");
    }

    function _mint(address miner) internal returns (uint256 tokenId) {
        uint256 nonce = _findNonce(miner, nft.targetFor(miner));
        (uint256 due,) = nft.currentMintDue();
        vm.prank(miner);
        nft.mint{value: due}(nonce);
        return nft.totalMinted();
    }

    function _emptyChoices() internal pure returns (CraftingControllerV2.SlotChoice[] memory c) {
        c = new CraftingControllerV2.SlotChoice[](0);
    }

    /// @dev Mints two cards to alice (second from bob, then transferred — keeps both mints at
    ///      21 bits to stay within the test gas limit).
    function _twoCardsToAlice() internal returns (uint256 a, uint256 b) {
        a = _mint(alice);
        b = _mint(bob);
        vm.prank(bob);
        nft.transferFrom(bob, alice, b);
        assertEq(nft.ownerOf(a), alice);
        assertEq(nft.ownerOf(b), alice);
    }

    // ---------------------------------------------------------------- tests

    function test_Craft_AtomicBurnAndForge_NoRefundPath() public {
        (uint256 a, uint256 b) = _twoCardsToAlice();

        vm.startPrank(alice);
        nft.approve(address(craft), a);
        nft.approve(address(craft), b);
        craft.craft{value: CRAFT_FEE}(a, b, _emptyChoices(), 0);
        vm.stopPrank();

        // parents burned in the same tx
        vm.expectRevert();
        nft.ownerOf(a);
        vm.expectRevert();
        nft.ownerOf(b);

        // child forged to the crafter, in the forge namespace
        uint256 child = 10_000_000;
        assertEq(nft.ownerOf(child), alice);
        assertEq(nft.totalForged(), 1);
        assertEq(nft.totalBurned(), 2);
        // post-inclusion entropy anchor recorded on the forged child
        assertEq(nft.mintBlockOf(child), uint64(block.number));
        assertTrue(nft.seedOf(child) != bytes32(0));
    }

    function test_Craft_WrongFee_Reverts() public {
        (uint256 a, uint256 b) = _twoCardsToAlice();
        vm.startPrank(alice);
        nft.approve(address(craft), a);
        nft.approve(address(craft), b);
        vm.expectRevert();
        craft.craft{value: CRAFT_FEE - 1}(a, b, _emptyChoices(), 0);
        vm.stopPrank();
    }

    function test_Craft_SameCard_Reverts() public {
        uint256 a = _mint(alice);
        vm.prank(alice);
        vm.expectRevert();
        craft.craft{value: CRAFT_FEE}(a, a, _emptyChoices(), 0);
    }

    function test_WithdrawFees_ToTreasury() public {
        (uint256 a, uint256 b) = _twoCardsToAlice();
        vm.startPrank(alice);
        nft.approve(address(craft), a);
        nft.approve(address(craft), b);
        craft.craft{value: CRAFT_FEE}(a, b, _emptyChoices(), 0);
        vm.stopPrank();

        uint256 before = treasury.balance;
        craft.withdrawFees();
        assertEq(treasury.balance - before, CRAFT_FEE);
    }
}
