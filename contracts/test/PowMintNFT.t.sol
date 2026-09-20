// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFT} from "../src/PowMintNFT.sol";

contract PowMintNFTTest is Test {
    PowMintNFT nft;

    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address treasury = address(0xFEE);

    string constant BASE = "https://t/x/api/";

    function setUp() public {
        nft = new PowMintNFT(
            "PowCats", "PWC", treasury, BASE,
            8, // baseBits
            2, // escalationBits
            1, // freeSupply
            2, // epochSize
            6, // maxSupply
            1e17, // priceStart (0.1 USDC)
            500, // royaltyBps = 5%
            3 // maxDoublings
        );
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------- helpers
    // NOTE: helpers hash locally (no external calls) so they never consume vm.prank,
    // and they double as an off-chain reference for the contract's preimage layout.

    function _lz(bytes32 h) internal pure returns (uint256 z) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        while ((x >> 255) == 0) {
            z++;
            x <<= 1;
        }
    }

    function _work(address target, address miner, uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, target, miner, nonce));
    }

    function _findNonceFor(address target, address miner, uint256 bits) internal view returns (uint256) {
        return _findNonceFrom(target, miner, bits, 0);
    }

    function _findNonceFrom(address target, address miner, uint256 bits, uint256 start)
        internal
        view
        returns (uint256)
    {
        uint256 n = start;
        while (true) {
            if (_lz(_work(target, miner, n)) >= bits) return n;
            n++;
        }
    }

    function _findWeakNonceFor(address target, address miner, uint256 bits) internal view returns (uint256) {
        uint256 n = 0;
        while (true) {
            if (_lz(_work(target, miner, n)) < bits) return n;
            n++;
        }
    }

    function _findNonce(address miner, uint256 bits) internal view returns (uint256) {
        return _findNonceFor(address(nft), miner, bits);
    }

    // --------------------------------------------------------------- tests

    function test_FreeMint_StoresSeedAndCounts() public {
        uint256 nonce = _findNonce(alice, 8);
        bytes32 expectedWork = _work(address(nft), alice, nonce);

        assertEq(nft.workFor(alice, nonce), expectedWork, "on-chain workFor must match local preimage");

        vm.prank(alice);
        nft.mint{value: 0}(nonce);

        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.totalMinted(), 1);
        assertEq(nft.mintCount(alice), 1);
        assertEq(nft.seedOf(1), expectedWork);
        assertEq(nft.nonceOf(1), nonce);
        assertEq(nft.currentEpoch(), 1); // free wave done
        assertEq(nft.currentPrice(), 1e17); // epoch price step 0
    }

    function test_BelowFloorReverts() public {
        uint256 weak = _findWeakNonceFor(address(nft), alice, 8);
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFT.BelowFloor.selector);
        nft.mint{value: 0}(weak);
    }

    function test_EscalationPerWallet() public {
        assertEq(nft.requiredBits(alice), 8);
        assertEq(nft.requiredBits(bob), 8);

        uint256 nonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(nonce);

        assertEq(nft.requiredBits(alice), 10); // +2 bits after one mint
        assertEq(nft.requiredBits(bob), 8); // unaffected
    }

    function test_PaidPhase_WrongAndCorrectPayment() public {
        uint256 aliceNonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(aliceNonce); // exhaust free supply

        uint256 bobNonce = _findNonce(bob, 8);

        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFT.WrongPayment.selector);
        nft.mint{value: 0}(bobNonce);

        vm.prank(bob);
        nft.mint{value: 1e17}(bobNonce);
        assertEq(nft.ownerOf(2), bob);
        assertEq(nft.totalPaid(), 1e17);
    }

    function test_EpochDoubling() public {
        uint256 aliceNonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(aliceNonce); // token 1, free

        uint256 bobNonce = _findNonce(bob, 8);
        vm.prank(bob);
        nft.mint{value: 1e17}(bobNonce); // token 2, epoch 1, step 0
        assertEq(nft.totalMinted(), 2);
        assertEq(nft.currentPrice(), 1e17); // (2-1)/2 = 0 -> still base price

        uint256 aliceNonce2 = _findNonceFrom(address(nft), alice, 10, aliceNonce + 1);
        vm.prank(alice);
        nft.mint{value: 1e17}(aliceNonce2); // token 3, step 0 stays until 3rd token
        assertEq(nft.totalMinted(), 3);
        assertEq(nft.currentPrice(), 2e17); // (3-1)/2 = 1 -> doubled
        assertEq(nft.currentEpoch(), 2);
    }

    function test_NonceReuseBlocked() public {
        uint256 nonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(nonce);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFT.NonceUsed.selector);
        nft.mint{value: 1e17}(nonce); // same nonce, correct payment for epoch 1
    }

    function test_WithdrawToTreasury() public {
        uint256 aliceNonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(aliceNonce);

        uint256 bobNonce = _findNonce(bob, 8);
        vm.prank(bob);
        nft.mint{value: 1e17}(bobNonce);

        assertEq(address(nft).balance, 1e17);
        nft.withdraw();
        assertEq(treasury.balance, 1e17);
        assertEq(address(nft).balance, 0);
    }

    function test_Pause() public {
        uint256 nonce = _findNonce(alice, 8);
        nft.setPaused(true);
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFT.MintPaused.selector);
        nft.mint{value: 0}(nonce);
    }

    function test_Royalty() public {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 1e18);
        assertEq(receiver, treasury);
        assertEq(amount, 5e16); // 5%
    }

    function test_TokenURI() public {
        uint256 nonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(nonce);
        assertEq(nft.tokenURI(1), string.concat(BASE, "1"));
        vm.expectRevert();
        nft.tokenURI(999);
    }

    function test_TransferAndApprovals() public {
        uint256 nonce = _findNonce(alice, 8);
        vm.prank(alice);
        nft.mint{value: 0}(nonce);

        vm.prank(alice);
        nft.approve(bob, 1);
        assertEq(nft.getApproved(1), bob);

        vm.prank(bob);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
        assertEq(nft.getApproved(1), address(0));
        assertEq(nft.balanceOf(alice), 0);
    }

    function test_OnlyOwner() public {
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFT.NotOwnerRole.selector);
        nft.setPaused(true);

        nft.transferOwnership(bob);
        assertEq(nft.owner(), bob);
    }

    function test_SoldOut() public {
        PowMintNFT small = new PowMintNFT("S", "S", treasury, BASE, 8, 2, 1, 2, 1, 1e17, 500, 3);

        uint256 aliceNonce = _findNonceFor(address(small), alice, 8);
        vm.prank(alice);
        small.mint{value: 0}(aliceNonce);

        uint256 bobNonce = _findNonceFor(address(small), bob, 8);
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFT.SoldOut.selector);
        small.mint{value: 1e17}(bobNonce);
    }

    // ------------------------------------------------- audit-fix regression tests

    function test_BadConfig_TreasuryIsZero() public {
        vm.expectRevert(PowMintNFT.InvalidTreasury.selector);
        new PowMintNFT("S", "S", address(0), BASE, 20, 2, 1, 2, 10, 1e17, 500, 6);
    }

    function test_BadConfig_TreasuryIsSelf() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(PowMintNFT.InvalidTreasury.selector);
        new PowMintNFT("S", "S", predicted, BASE, 20, 2, 1, 2, 10, 1e17, 500, 6);
    }

    function test_BadConfig_EscalationMustBeTwo() public {
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("S", "S", treasury, BASE, 20, 3, 1, 2, 10, 1e17, 500, 6);
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("S", "S", treasury, BASE, 20, 0, 1, 2, 10, 1e17, 500, 6);
    }

    function test_BadConfig_PriceOverflow() public {
        // priceStart = 2^255 with maxDoublings = 2 would overflow priceStart * 2^step
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("S", "S", treasury, BASE, 20, 2, 1, 2, 10, uint256(1) << 255, 500, 2);
    }

    function test_TreasuryPinned_RoyaltyReceiverImmutable() public {
        vm.prank(alice);
        nft.mint{value: 0}(_findNonce(alice, 8));
        vm.prank(bob);
        nft.mint{value: 1e17}(_findNonce(bob, 8));
        nft.withdraw();
        assertEq(treasury.balance, 1e17); // always the deploy-time treasury

        (address recv,) = nft.royaltyInfo(1, 1e18);
        assertEq(recv, treasury); // royalties pinned to the same address
    }
}
