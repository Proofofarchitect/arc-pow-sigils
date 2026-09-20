// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFT} from "../src/PowMintNFT.sol";
import {ERC721Minimal, IERC721Receiver} from "../src/ERC721Minimal.sol";

/// @title PowMintNFTFuzz — merged ASCN fuzz / invariant suite.
///
/// @dev This file consolidates the strongest ideas from three generated ASCN
///      suites (earlier fuzz suites), adapted to the REAL v2 contract.
///
///      Base:      r1  (9 stateful invariants + multi-actor handler)
///      Merged in: r2  (adversarial mint matrix, safe-transfer variants)
///                 r3  (testFuzz_* property tests, approval matrix, NoReceiver)
///
///      Adaptations to v2 reality (generated suites were written against
///      assumptions that do NOT match src/PowMintNFT.sol):
///        * escalationBits is fixed at +2 (constructor: `escalationBits_ != 2`
///          -> BadConfig). r1/r2/r3 all pass 0 or 1 -> would not deploy.
///        * treasury is IMMUTABLE. There is no setTreasury(); all
///          setTreasury(...) calls from r1/r2/r3 were removed.
///        * ZeroAddress is only reachable via transferOwnership(address(0));
///          setTreasury(address(0)) does not exist.
///        * mint() check order is pause -> soldOut -> payment -> nonce -> bits,
///          so reusing a nonce in a paid epoch must send the exact price or the
///          wrong-payment branch fires first (r1 sent value 0 -> wrong revert).
///        * seedOf[tokenId] is keyed by the MINTER (msg.sender). The handler
///          never transfers, so ownerOf == miner holds in the seed invariant.
///        * r2's `invariant_P7_royaltyFormula(uint256)` is not a valid invariant
///          (invariants take no args); it is exercised as a fuzz test here.
///        * r3 installs its handler behind `_installHandler()` that is never
///          called from setUp(); wired up properly here.
///        * baseBits kept small and per-actor mints capped so proof-of-work
///          grinding stays fast and bounded.

// ---------------------------------------------------------------------------
// Fixtures: mint actor, receivers
// ---------------------------------------------------------------------------

contract FuzzMintActor {
    function mine(PowMintNFT nft, uint256 nonce) external payable {
        nft.mint{value: msg.value}(nonce);
    }

    receive() external payable {}
}

contract GoodReceiver is IERC721Receiver {
    uint256 public lastTokenId;
    bytes public lastData;

    function onERC721Received(address, address, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        lastTokenId = tokenId;
        lastData = data;
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Returns a wrong magic value → contract must revert UnsafeRecipient.
contract BadReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @dev Reverts inside the callback → whole safeTransferFrom must roll back.
contract RevertingReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("receiver rejected");
    }
}

/// @dev Contract with no onERC721Received at all → the raw call reverts.
contract NoReceiver {}

// ---------------------------------------------------------------------------
// Stateful handler for the invariant campaign
// ---------------------------------------------------------------------------

contract PowMintHandler {
    PowMintNFT public immutable nft;

    uint256 internal constant GRIND = 65_536; // bounded proof-of-work search
    uint256 public constant MAX_PER_ACTOR = 4; // keeps escalation bits bounded

    FuzzMintActor[] public actors;

    uint256 public successfulMints;
    uint256 public totalPaidGhost;
    uint256 public withdrawnGhost;
    uint256 public maxPriceObserved;

    mapping(address => uint256) public mintsByWalletGhost;
    mapping(address => mapping(uint256 => bool)) public usedNonceGhost;

    constructor(PowMintNFT nft_) {
        nft = nft_;
        for (uint256 i; i < 4; ++i) {
            actors.push(new FuzzMintActor());
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actor(uint256 i) external view returns (address) {
        return address(actors[i]);
    }

    function mint(uint256 seed) external {
        if (nft.totalMinted() >= nft.maxSupply()) {
            _observe();
            return;
        }

        uint256 idx = seed % actors.length;
        address miner = address(actors[idx]);

        if (mintsByWalletGhost[miner] >= MAX_PER_ACTOR) {
            _observe();
            return;
        }

        uint8 need = nft.requiredBits(miner);
        uint256 price = nft.currentPrice();

        uint256 nonce;
        bool found;
        for (uint256 i; i < GRIND; ++i) {
            uint256 cand = uint256(keccak256(abi.encodePacked(seed, i)));
            if (usedNonceGhost[miner][cand]) continue;
            if (_lz(keccak256(abi.encodePacked(block.chainid, address(nft), miner, cand))) >= need) {
                nonce = cand;
                found = true;
                break;
            }
        }

        if (!found) {
            _observe();
            return;
        }

        actors[idx].mine{value: price}(nft, nonce);

        usedNonceGhost[miner][nonce] = true;
        mintsByWalletGhost[miner] += 1;
        successfulMints += 1;
        totalPaidGhost += price;

        _observe();
    }

    function withdraw() external {
        uint256 bal = address(nft).balance;
        nft.withdraw();
        withdrawnGhost += bal;
    }

    function _observe() internal {
        uint256 p = nft.currentPrice();
        if (p > maxPriceObserved) maxPriceObserved = p;
    }

    function _lz(bytes32 h) internal pure returns (uint256 z) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        if (x >> 128 == 0) z += 128;
        else x >>= 128;
        if (x >> 64 == 0) z += 64;
        else x >>= 64;
        if (x >> 32 == 0) z += 32;
        else x >>= 32;
        if (x >> 16 == 0) z += 16;
        else x >>= 16;
        if (x >> 8 == 0) z += 8;
        else x >>= 8;
        if (x >> 4 == 0) z += 4;
        else x >>= 4;
        if (x >> 2 == 0) z += 2;
        else x >>= 2;
        if (x >> 1 == 0) z += 1;
    }
}

// ---------------------------------------------------------------------------
// Test contract
// ---------------------------------------------------------------------------

contract PowMintNFTFuzzTest is Test {
    PowMintNFT internal nft;
    PowMintHandler internal handler;

    address internal treasury = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA701);

    string internal constant BASE = "https://t/x/api/";

    // Invariant deployment: tiny difficulty so proof-of-work is fast/bounded.
    uint8 internal constant BASE_BITS = 4;
    uint256 internal constant PRICE_START = 1 ether;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    function setUp() public {
        nft = _deploy(treasury, BASE_BITS, 1, 2, 16, PRICE_START, 500, 3);

        handler = new PowMintHandler(nft);
        for (uint256 i; i < handler.actorCount(); ++i) {
            vm.deal(handler.actor(i), 1_000 ether);
        }
        vm.deal(address(handler), 1_000 ether);

        targetContract(address(handler));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ------------------------------------------------------------- helpers

    function _deploy(
        address treasury_,
        uint8 baseBits_,
        uint256 freeSupply_,
        uint256 epochSize_,
        uint256 maxSupply_,
        uint256 priceStart_,
        uint96 royaltyBps_,
        uint8 maxDoublings_
    ) internal returns (PowMintNFT) {
        return new PowMintNFT(
            "PoW NFT",
            "POW",
            treasury_,
            BASE,
            baseBits_,
            2, // escalationBits is fixed at 2 by the v2 constructor
            freeSupply_,
            epochSize_,
            maxSupply_,
            priceStart_,
            royaltyBps_,
            maxDoublings_
        );
    }

    /// @dev Mirror of the contract's leading-zero-bit counter.
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

    function _findWeakNonceFor(address target, address miner, uint256 bits) internal view returns (uint256 n) {
        while (true) {
            if (_lz(_work(target, miner, n)) < bits) return n;
            n++;
        }
    }

    /// @dev First nonce meeting `bits` that the contract has NOT already consumed
    ///      for `miner` (avoids NonceUsed when the same miner mints repeatedly).
    function _findFreshNonce(address target, address miner, uint256 bits) internal view returns (uint256 n) {
        while (true) {
            if (!PowMintNFT(target).nonceUsed(miner, n) && _lz(_work(target, miner, n)) >= bits) return n;
            n++;
        }
    }

    /// @dev Mint as `miner` on `target`, paying the exact current price.
    ///      Price is read BEFORE vm.prank so the prank is not consumed by the
    ///      view call (arg evaluation would otherwise steal the cheatcode).
    function _mintAs(PowMintNFT target, address miner) internal returns (uint256 tokenId, uint256 nonce) {
        nonce = _findFreshNonce(address(target), miner, target.requiredBits(miner));
        uint256 price = target.currentPrice();
        vm.deal(miner, price + 1 ether);
        vm.prank(miner);
        target.mint{value: price}(nonce);
        tokenId = target.totalMinted();
    }

    function _expectedPrice(uint256 minted) internal view returns (uint256) {
        if (minted < nft.freeSupply()) return 0;
        uint256 step = (minted - nft.freeSupply()) / nft.epochSize();
        if (step > nft.maxDoublings()) step = nft.maxDoublings();
        return nft.priceStart() * (uint256(1) << step);
    }

    // =============================================================
    // Stateful invariants (r1 base, 9 invariants + tighter accounting)
    // =============================================================

    function invariant_totalMintedEqualsSuccessfulMints() public view {
        assertEq(nft.totalMinted(), handler.successfulMints());
        assertLe(nft.totalMinted(), nft.maxSupply());
    }

    function invariant_walletDifficultyMatchesMintCount() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address wallet = handler.actor(i);
            uint256 count = nft.mintCount(wallet);

            assertEq(count, handler.mintsByWalletGhost(wallet));

            uint256 expected = uint256(nft.baseBits()) + uint256(nft.escalationBits()) * count;
            if (expected > 250) expected = 250;

            assertEq(uint256(nft.requiredBits(wallet)), expected);
        }
    }

    function invariant_requiredBitsAreNeverBelowBase() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address wallet = handler.actor(i);
            assertGe(nft.requiredBits(wallet), nft.baseBits());
            assertLe(nft.requiredBits(wallet), 250);
        }
    }

    function invariant_priceMatchesSupplyFormula() public view {
        uint256 minted = nft.totalMinted();
        uint256 expected;

        if (minted < nft.freeSupply()) {
            expected = 0;
        } else {
            uint256 step = (minted - nft.freeSupply()) / nft.epochSize();
            if (step > nft.maxDoublings()) step = nft.maxDoublings();
            expected = nft.priceStart() * (uint256(1) << step);
        }

        assertEq(nft.currentPrice(), expected);
        assertGe(nft.currentPrice(), handler.maxPriceObserved());
    }

    function invariant_priceIsNonDecreasingWithMintCount() public view {
        uint256 minted = nft.totalMinted();
        uint256 price = nft.currentPrice();

        if (minted < nft.freeSupply()) {
            assertEq(price, 0);
            return;
        }

        uint256 priorMinted = minted == 0 ? 0 : minted - 1;
        uint256 priorPrice;

        if (priorMinted < nft.freeSupply()) {
            priorPrice = 0;
        } else {
            uint256 step = (priorMinted - nft.freeSupply()) / nft.epochSize();
            if (step > nft.maxDoublings()) step = nft.maxDoublings();
            priorPrice = nft.priceStart() * (uint256(1) << step);
        }

        assertGe(price, priorPrice);
    }

    function invariant_contractBalanceAndTotalPaidAccounting() public view {
        assertEq(address(nft).balance, handler.totalPaidGhost() - handler.withdrawnGhost());
        assertEq(nft.totalPaid(), handler.totalPaidGhost());
    }

    function invariant_mintedTokenSeedsAreExact() public view {
        for (uint256 tokenId = 1; tokenId <= nft.totalMinted(); ++tokenId) {
            address miner = nft.ownerOf(tokenId); // handler never transfers => miner
            uint256 nonce = nft.nonceOf(tokenId);
            bytes32 expected = keccak256(abi.encodePacked(block.chainid, address(nft), miner, nonce));
            assertEq(nft.seedOf(tokenId), expected);
        }
    }

    function invariant_recordedNoncesAreMarkedUsed() public view {
        for (uint256 tokenId = 1; tokenId <= nft.totalMinted(); ++tokenId) {
            address miner = nft.ownerOf(tokenId);
            uint256 nonce = nft.nonceOf(tokenId);
            assertTrue(nft.nonceUsed(miner, nonce));
        }
    }

    function invariant_handlerGhostNoncesMatchContract() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address wallet = handler.actor(i);
            for (uint256 tokenId = 1; tokenId <= nft.totalMinted(); ++tokenId) {
                if (nft.ownerOf(tokenId) == wallet) {
                    uint256 nonce = nft.nonceOf(tokenId);
                    assertTrue(handler.usedNonceGhost(wallet, nonce));
                    assertTrue(nft.nonceUsed(wallet, nonce));
                }
            }
        }
    }

    function invariant_balanceNeverBelowUnwithdrawnPaid() public view {
        // contract balance can only ever hold unwithdrawn proceeds
        assertLe(address(nft).balance, nft.totalPaid());
    }

    // =============================================================
    // Adversarial mint tests (r1 + r2 + r3 merged)
    // =============================================================

    function test_mintWhilePausedReverts() public {
        nft.setPaused(true);
        uint256 nonce = _findFreshNonce(address(nft), alice, nft.requiredBits(alice));

        vm.prank(alice);
        vm.expectRevert(PowMintNFT.MintPaused.selector);
        nft.mint{value: 0}(nonce);
    }

    function test_wrongPaymentFreePhaseReverts() public {
        uint256 nonce = _findFreshNonce(address(nft), alice, nft.requiredBits(alice));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFT.WrongPayment.selector, 1 ether, 0));
        nft.mint{value: 1 ether}(nonce);
    }

    function test_wrongPaymentPaidPhaseReverts() public {
        _mintAs(nft, alice); // exhaust free supply (freeSupply = 1)
        uint256 price = nft.currentPrice(); // 1 ether
        uint256 nonce = _findFreshNonce(address(nft), bob, nft.requiredBits(bob));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFT.WrongPayment.selector, price - 1, price));
        nft.mint{value: price - 1}(nonce);
    }

    function test_freeMintStoresSeedAndCounts() public {
        uint256 nonce = _findFreshNonce(address(nft), alice, nft.requiredBits(alice));
        bytes32 expectedWork = _work(address(nft), alice, nonce);
        assertEq(nft.workFor(alice, nonce), expectedWork);

        vm.prank(alice);
        nft.mint{value: 0}(nonce);

        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.totalMinted(), 1);
        assertEq(nft.mintCount(alice), 1);
        assertEq(nft.seedOf(1), expectedWork);
        assertEq(nft.nonceOf(1), nonce);
    }

    function test_belowFloorReverts() public {
        uint8 bits = nft.baseBits();
        uint256 weak = _findWeakNonceFor(address(nft), alice, bits);
        uint256 got = _lz(_work(address(nft), alice, weak));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFT.BelowFloor.selector, uint8(got), bits));
        nft.mint{value: 0}(weak);
    }

    function test_escalationPerWalletIsPlusTwo() public {
        uint8 base = nft.baseBits();
        assertEq(nft.requiredBits(alice), base);
        assertEq(nft.requiredBits(bob), base);

        _mintAs(nft, alice);

        assertEq(nft.requiredBits(alice), base + 2); // +2 after one mint
        assertEq(nft.requiredBits(bob), base); // unaffected

        _mintAs(nft, alice);
        assertEq(nft.requiredBits(alice), base + 4);
    }

    function test_nonceCannotBeReusedBySameWallet() public {
        (uint256 tokenId, uint256 nonce) = _mintAs(nft, alice);
        assertEq(tokenId, 1);

        uint256 price = nft.currentPrice();
        vm.prank(alice);
        vm.expectRevert(PowMintNFT.NonceUsed.selector);
        nft.mint{value: price}(nonce); // paid epoch -> must send exact price
    }

    function test_nonceIsWalletScoped() public {
        // small paid collection, tiny difficulty, price fixed at 1 wei
        PowMintNFT small = _deploy(treasury, 2, 0, 1, 4, 1, 500, 0);

        uint256 common;
        bool found;
        for (uint256 i; i < 200_000; ++i) {
            if (_lz(_work(address(small), alice, i)) >= 2 && _lz(_work(address(small), bob, i)) >= 2) {
                common = i;
                found = true;
                break;
            }
        }
        assertTrue(found, "common nonce not found");

        vm.prank(alice);
        small.mint{value: 1}(common);
        assertTrue(small.nonceUsed(alice, common));
        assertFalse(small.nonceUsed(bob, common));

        vm.prank(bob);
        small.mint{value: 1}(common);
        assertTrue(small.nonceUsed(bob, common));
        assertEq(small.totalMinted(), 2);
    }

    function test_soldOutReverts() public {
        PowMintNFT small = _deploy(treasury, 4, 0, 1, 1, 1 ether, 500, 1);
        _mintAs(small, alice);

        uint256 nonce = _findFreshNonce(address(small), bob, small.requiredBits(bob));
        uint256 price = small.currentPrice();
        vm.prank(bob);
        vm.expectRevert(PowMintNFT.SoldOut.selector);
        small.mint{value: price}(nonce);
    }

    // =============================================================
    // Owner / treasury / withdrawal
    // =============================================================

    function test_ownerOnlyFunctionsRejectNonOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(PowMintNFT.NotOwnerRole.selector);
        nft.setBaseURI("ipfs://attacker/");
        vm.expectRevert(PowMintNFT.NotOwnerRole.selector);
        nft.setPaused(true);
        vm.expectRevert(PowMintNFT.NotOwnerRole.selector);
        nft.transferOwnership(bob);
        vm.stopPrank();
    }

    function test_ownerCanUpdateAdministrativeState() public {
        nft.setBaseURI("ipfs://updated/");
        assertEq(nft.baseURI(), "ipfs://updated/");

        nft.setPaused(true);
        assertTrue(nft.mintPaused());
        nft.setPaused(false);
        assertFalse(nft.mintPaused());

        nft.transferOwnership(alice);
        assertEq(nft.owner(), alice);
        vm.prank(alice);
        nft.setBaseURI("ipfs://alice/");
        assertEq(nft.baseURI(), "ipfs://alice/");
    }

    function test_transferOwnershipToZeroReverts() public {
        vm.expectRevert(PowMintNFT.ZeroAddress.selector);
        nft.transferOwnership(address(0));
    }

    function test_treasuryIsImmutableAndRoyaltyReceiverPinned() public {
        _mintAs(nft, alice);

        (address recv,) = nft.royaltyInfo(1, 1e18);
        assertEq(recv, treasury); // royalties pinned to deploy-time treasury

        // no admin surface can move proceeds away from the pinned treasury
        _mintAs(nft, bob);
        uint256 paid = address(nft).balance;
        nft.withdraw();
        assertEq(treasury.balance, paid);
    }

    function test_withdrawSendsEverythingToTreasury() public {
        _mintAs(nft, alice);
        _mintAs(nft, bob);

        uint256 bal = address(nft).balance;
        uint256 before = treasury.balance;
        assertEq(bal, nft.totalPaid());

        nft.withdraw();
        assertEq(address(nft).balance, 0);
        assertEq(treasury.balance, before + bal);
    }

    function test_withdrawCanBeCalledByAnyone() public {
        PowMintNFT paid = _deploy(treasury, 4, 0, 1, 2, 2 ether, 500, 1);
        _mintAs(paid, alice);

        uint256 bal = address(paid).balance;
        vm.prank(bob);
        paid.withdraw();
        assertEq(address(paid).balance, 0);
        assertEq(treasury.balance, bal);
    }

    // =============================================================
    // Constructor validation
    // =============================================================

    function test_badConfigsRevert() public {
        // zero maxSupply
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 1, 0, 1, 500, 1);

        // zero epochSize
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 0, 1, 1, 500, 1);

        // freeSupply > maxSupply
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 2, 1, 1, 1, 500, 1);

        // baseBits == 0
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 0, 2, 0, 1, 1, 1, 500, 1);

        // royaltyBps > 1000
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 1, 1, 1, 1001, 1);

        // escalationBits != 2
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 1, 0, 1, 1, 1, 500, 1);
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 0, 0, 1, 1, 1, 500, 1);

        // maxDoublings > 64
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 1, 1, 1, 500, 65);

        // priceStart == 0 while paid tokens exist
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 1, 1, 0, 500, 1);
    }

    function test_invalidTreasuryReverts() public {
        vm.expectRevert(PowMintNFT.InvalidTreasury.selector);
        new PowMintNFT("x", "x", address(0), BASE, 8, 2, 0, 1, 1, 1, 500, 1);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(PowMintNFT.InvalidTreasury.selector);
        new PowMintNFT("x", "x", predicted, BASE, 8, 2, 0, 1, 1, 1, 500, 1);
    }

    function test_priceOverflowConfigReverts() public {
        vm.expectRevert(PowMintNFT.BadConfig.selector);
        new PowMintNFT("x", "x", treasury, BASE, 8, 2, 0, 1, 1, uint256(1) << 255, 500, 2);
    }

    // =============================================================
    // ERC-721 approval + transfer matrix (operator case included)
    // =============================================================

    function test_transferFromOwnerWorks() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        assertEq(nft.ownerOf(tokenId), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_transferFromApprovedWorksAndClears() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.approve(bob, tokenId);
        assertEq(nft.getApproved(tokenId), bob);

        vm.prank(bob);
        nft.transferFrom(alice, carol, tokenId);

        assertEq(nft.ownerOf(tokenId), carol);
        assertEq(nft.getApproved(tokenId), address(0));
    }

    function test_transferFromOperatorWorks() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.setApprovalForAll(bob, true);
        assertTrue(nft.isApprovedForAll(alice, bob));

        vm.prank(bob);
        nft.transferFrom(alice, carol, tokenId);
        assertEq(nft.ownerOf(tokenId), carol);
    }

    function test_revokedOperatorCannotTransfer() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.startPrank(alice);
        nft.setApprovalForAll(bob, true);
        nft.setApprovalForAll(bob, false);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(ERC721Minimal.NotAuthorized.selector);
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_operatorCanApprove() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.setApprovalForAll(carol, true);

        vm.prank(carol);
        nft.approve(bob, tokenId);
        assertEq(nft.getApproved(tokenId), bob);
    }

    function test_approveByNonOperatorReverts() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(bob);
        vm.expectRevert(ERC721Minimal.NotAuthorized.selector);
        nft.approve(carol, tokenId);
    }

    function test_transferFromUnauthorizedReverts() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(bob);
        vm.expectRevert(ERC721Minimal.NotAuthorized.selector);
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_wrongFromReverts() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        // bob is not the owner of tokenId
        vm.prank(bob);
        vm.expectRevert(ERC721Minimal.WrongFrom.selector);
        nft.transferFrom(bob, carol, tokenId);
    }

    function test_transferToZeroReverts() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        vm.expectRevert(ERC721Minimal.ToZero.selector);
        nft.transferFrom(alice, address(0), tokenId);
    }

    function test_selfTransferWorks() public {
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.transferFrom(alice, alice, tokenId);

        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(nft.balanceOf(alice), 1);
    }

    function test_approveNonexistentTokenReverts() public {
        vm.expectRevert(ERC721Minimal.NoToken.selector);
        nft.approve(bob, 999);
    }

    // =============================================================
    // safeTransferFrom receiver checks (both overloads)
    // =============================================================

    function test_safeTransferToGoodReceiverBothOverloads() public {
        GoodReceiver r = new GoodReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.safeTransferFrom(alice, address(r), tokenId);
        assertEq(nft.ownerOf(tokenId), address(r));
        assertEq(r.lastTokenId(), tokenId);

        (uint256 tokenId2,) = _mintAs(nft, alice);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(r), tokenId2, hex"123456");
        assertEq(nft.ownerOf(tokenId2), address(r));
        assertEq(r.lastData(), hex"123456");
    }

    function test_safeTransferToEOAWorks() public {
        (uint256 tokenId,) = _mintAs(nft, alice);
        vm.prank(alice);
        nft.safeTransferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_safeTransferFromOperatorToContract() public {
        GoodReceiver r = new GoodReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        nft.setApprovalForAll(bob, true);

        vm.prank(bob);
        nft.safeTransferFrom(alice, address(r), tokenId);
        assertEq(nft.ownerOf(tokenId), address(r));
    }

    function test_safeTransferToBadReceiverRevertsAndRollsBack() public {
        BadReceiver r = new BadReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        vm.expectRevert(ERC721Minimal.UnsafeRecipient.selector);
        nft.safeTransferFrom(alice, address(r), tokenId);

        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(nft.balanceOf(address(r)), 0);
    }

    function test_safeTransferWithDataToBadReceiverReverts() public {
        BadReceiver r = new BadReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        vm.expectRevert(ERC721Minimal.UnsafeRecipient.selector);
        nft.safeTransferFrom(alice, address(r), tokenId, hex"abcdef");
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_safeTransferToRevertingReceiverReverts() public {
        RevertingReceiver r = new RevertingReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        vm.expectRevert("receiver rejected");
        nft.safeTransferFrom(alice, address(r), tokenId);
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_safeTransferToNonReceiverContractReverts() public {
        NoReceiver r = new NoReceiver();
        (uint256 tokenId,) = _mintAs(nft, alice);

        vm.prank(alice);
        vm.expectRevert();
        nft.safeTransferFrom(alice, address(r), tokenId);
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_selfSafeTransferWorks() public {
        (uint256 tokenId,) = _mintAs(nft, alice);
        vm.prank(alice);
        nft.safeTransferFrom(alice, alice, tokenId);
        assertEq(nft.ownerOf(tokenId), alice);
    }

    // =============================================================
    // ERC-2981 / ERC-165 / metadata
    // =============================================================

    function test_supportsInterfaces() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC-721 metadata
        assertTrue(nft.supportsInterface(0x2a55205a)); // ERC-2981
        assertFalse(nft.supportsInterface(0xdeadbeef));
    }

    function test_tokenURIUsesBaseURI() public {
        (uint256 tokenId,) = _mintAs(nft, alice);
        assertEq(nft.tokenURI(tokenId), string.concat(BASE, "1"));
    }

    function test_tokenURINonexistentReverts() public {
        vm.expectRevert(ERC721Minimal.NoToken.selector);
        nft.tokenURI(999);
    }

    // =============================================================
    // Bounded fuzz property tests (r2 + r3, adapted)
    // =============================================================

    function testFuzz_royaltyAmount(uint256 salePrice) public view {
        salePrice = bound(salePrice, 0, type(uint128).max);
        (address recv, uint256 amount) = nft.royaltyInfo(123, salePrice);
        assertEq(recv, treasury);
        assertEq(amount, salePrice * uint256(nft.royaltyBps()) / 10_000);
    }

    /// @dev Price formula checked against the real state machine. Uses a fresh
    ///      miner per token so escalation (and thus grind cost) stay flat.
    function testFuzz_currentPriceMatchesFormula(uint256 n) public {
        PowMintNFT c = _deploy(treasury, 1, 0, 2, 8, 1 ether, 500, 2);
        n = bound(n, 0, c.maxSupply());

        for (uint256 i; i < n; ++i) {
            uint256 minted = c.totalMinted();
            uint256 expected;
            if (minted < c.freeSupply()) {
                expected = 0;
            } else {
                uint256 step = (minted - c.freeSupply()) / c.epochSize();
                if (step > c.maxDoublings()) step = c.maxDoublings();
                expected = c.priceStart() * (uint256(1) << step);
            }
            assertEq(c.currentPrice(), expected, "price formula mismatch");

            address miner = address(uint160(0x100000 + i));
            uint256 nonce = _findFreshNonce(address(c), miner, c.requiredBits(miner));
            uint256 price = c.currentPrice(); // read BEFORE prank
            vm.deal(miner, price + 1 ether);
            vm.prank(miner);
            c.mint{value: price}(nonce);
        }

        assertEq(c.totalMinted(), n);
    }

    /// @dev requiredBits == baseBits + 2*mintCount for a wallet, monotonic.
    function testFuzz_requiredBitsFormula(uint256 mints) public {
        PowMintNFT c = _deploy(treasury, 4, 0, 1, 32, 1 ether, 500, 2);
        mints = bound(mints, 0, 4); // cap: keep grind bounded
        vm.deal(alice, 1_000 ether);

        uint256 prev = c.requiredBits(alice);
        for (uint256 i; i < mints; ++i) {
            _mintAs(c, alice);
            uint256 expected = uint256(c.baseBits()) + uint256(c.escalationBits()) * c.mintCount(alice);
            if (expected > 250) expected = 250;
            assertEq(uint256(c.requiredBits(alice)), expected);
            assertGe(c.requiredBits(alice), prev);
            prev = c.requiredBits(alice);
        }
    }

    /// @dev A nonce that meets the floor mints; one that doesn't reverts.
    function testFuzz_powFloorEnforced(uint256 nonce) public {
        PowMintNFT c = _deploy(treasury, 4, 0, 1, 4, 1, 500, 0); // price fixed 1 wei
        address miner = address(uint160(uint256(keccak256(abi.encodePacked("miner", nonce)))));
        vm.deal(miner, 100);

        uint256 got = _lz(_work(address(c), miner, nonce));
        if (got >= 4) {
            vm.prank(miner);
            c.mint{value: 1}(nonce);
            assertEq(c.ownerOf(1), miner);
        } else {
            vm.prank(miner);
            vm.expectRevert(
                abi.encodeWithSelector(PowMintNFT.BelowFloor.selector, uint8(got), uint8(4))
            );
            c.mint{value: 1}(nonce);
        }
    }
}
