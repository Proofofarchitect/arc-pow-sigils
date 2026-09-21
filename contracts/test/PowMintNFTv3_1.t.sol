// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {PowMintNFTv3_1} from "../src/PowMintNFTv3_1.sol";
import {ERC721Minimal} from "../src/ERC721Minimal.sol";

/// @title PowMintNFTv3_1Test — unit suite for the v3.1 delta (burn / forge-quota /
///        module registry / staking discount) plus regression checks that v3 behavior
///        (price ladder, claims, locks, royalties, ownership) is untouched.
contract PowMintNFTv3_1Test is Test {
    using stdStorage for StdStorage;

    PowMintNFTv3_1 nft;

    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address nominee = address(0xBEEF);
    address treasury = address(0xFEE);
    address module = address(0xD0D);

    string constant BASE = "https://t/x/api/";

    // Main instance: baseBits=8, epochSize=2, freeClaims=2, maxSupply=22 → paidSupply=20.
    uint8 constant BASE_BITS = 8;
    uint256 constant PRICE_START = 1e17;
    uint256 constant EPOCH_SIZE = 2;
    uint256 constant FREE_CLAIMS = 2;
    uint256 constant MAX_SUPPLY = 22;
    uint256 constant REG_WINDOW = 3;
    uint256 constant PACE_TARGET = 60;

    function setUp() public {
        nft = _deploy(BASE_BITS, PRICE_START, EPOCH_SIZE, FREE_CLAIMS, MAX_SUPPLY, 500, 0, REG_WINDOW, PACE_TARGET);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    function _deploy(
        uint8 baseBits_,
        uint256 priceStart_,
        uint256 epochSize_,
        uint256 freeClaims_,
        uint256 maxSupply_,
        uint96 royaltyBps_,
        uint256 mintFeeBps_,
        uint256 regWindow_,
        uint256 paceTargetS_
    ) internal returns (PowMintNFTv3_1) {
        return new PowMintNFTv3_1(
            "POVA", "PV31", treasury, BASE,
            baseBits_, priceStart_, epochSize_, freeClaims_, maxSupply_, royaltyBps_, mintFeeBps_, regWindow_,
            paceTargetS_
        );
    }

    // ------------------------------------------------------------- helpers

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

    mapping(address => uint256) private _nonceCursor;

    /// @dev Mine with a slow pace (warp +400s): keeps the load regulator at 0 and
    ///      lets streaks expire, so difficulty stays at the wave base.
    function _mineW(PowMintNFTv3_1 n, address miner) internal returns (uint256 tokenId) {
        vm.warp(block.timestamp + 400);
        uint256 bits = n.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(n), miner, bits, _nonceCursor[miner]);
        _nonceCursor[miner] = nonce + 1;
        uint256 price = n.currentPrice();
        vm.deal(miner, price + 1 ether);
        vm.prank(miner);
        n.mint{value: price}(nonce);
        tokenId = n.totalMinted();
    }

    function _claimOn(PowMintNFTv3_1 n, address who, bytes32 code) internal returns (uint256 tokenId) {
        vm.prank(who);
        n.claim(code);
        tokenId = n.totalMinted();
    }

    function _enableModule(address m) internal {
        nft.setModule(m, true);
    }

    // ====================================================== burns (v3.1)

    function test_Burn_ByOwner() public {
        uint256 id = _mineW(nft, alice);

        vm.expectEmit(true, true, false, true, address(nft));
        emit PowMintNFTv3_1.Burned(alice, id);

        vm.prank(alice);
        nft.burn(id);

        vm.expectRevert();
        nft.ownerOf(id);
        assertEq(nft.totalBurned(), 1, "totalBurned");
        assertEq(nft.balanceOf(alice), 0, "balance after burn");
        assertEq(nft.circulating(), nft.totalMinted() - 1, "circulating");
    }

    function test_Burn_ByApproved() public {
        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.approve(bob, id);

        vm.prank(bob);
        nft.burn(id);
        assertEq(nft.totalBurned(), 1);
    }

    function test_Burn_ByOperator() public {
        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.setApprovalForAll(bob, true);

        vm.prank(bob);
        nft.burn(id);
        assertEq(nft.totalBurned(), 1);
    }

    function test_Burn_RevertsForStranger() public {
        uint256 id = _mineW(nft, alice);
        vm.expectRevert(ERC721Minimal.NotAuthorized.selector);
        vm.prank(carol);
        nft.burn(id);
    }

    function test_Burn_RevertsForNonexistentAndTwice() public {
        vm.expectRevert(ERC721Minimal.NoToken.selector);
        nft.burn(999);

        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);

        vm.expectRevert(ERC721Minimal.NoToken.selector);
        vm.prank(alice);
        nft.burn(id);
    }

    function test_Burn_FreeTokenAllowedWhileLocked() public {
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("code1")));
        nft.addCodes(hs);

        uint256 id = _claimOn(nft, alice, bytes32("code1"));
        assertTrue(nft.isFreeToken(id));
        assertLt(nft.currentWave(), nft.LOCK_WAVES());

        // transfer is locked...
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3_1.FreeTokenLocked.selector, id));
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);

        // ...but burning is allowed (lock restricts transfers, not deflation)
        vm.prank(alice);
        nft.burn(id);
        assertEq(nft.totalBurned(), 1);
    }

    function test_Burn_DoesNotMovePriceLadder() public {
        uint256 idA = _mineW(nft, alice); // paid #1 → epoch 0
        _mineW(nft, bob); // paid #2 → epoch 1
        assertEq(nft.epochIndex(), 1);
        assertEq(nft.currentPrice(), 2 * PRICE_START);

        vm.prank(alice);
        nft.burn(idA);

        assertEq(nft.epochIndex(), 1, "epoch unchanged");
        assertEq(nft.currentPrice(), 2 * PRICE_START, "price unchanged");
        assertEq(nft.paidMinted(), 2, "paidMinted unchanged");
    }

    function test_Burn_WorksWhileMintPaused() public {
        uint256 id = _mineW(nft, alice);
        nft.setPaused(true);

        vm.prank(alice);
        nft.burn(id); // allowed
        assertEq(nft.totalBurned(), 1);

        vm.prank(bob);
        vm.expectRevert(PowMintNFTv3_1.MintPaused.selector);
        nft.mint{value: PRICE_START}(1);
    }

    // ====================================================== forge (v3.1)

    function test_Forge_OnlyModule() public {
        vm.expectRevert(PowMintNFTv3_1.NotModule.selector);
        nft.forgeMint(alice, bytes32(uint256(1)));

        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);

        _enableModule(module);
        vm.prank(module);
        nft.forgeMint(carol, bytes32(uint256(1)));
        assertEq(nft.totalForged(), 1);

        // revoking the module stops forge again
        nft.setModule(module, false);
        vm.expectRevert(PowMintNFTv3_1.NotModule.selector);
        vm.prank(module);
        nft.forgeMint(carol, bytes32(uint256(2)));
    }

    function test_Forge_RequiresBurn() public {
        _enableModule(module);
        vm.expectRevert(PowMintNFTv3_1.NothingBurned.selector);
        vm.prank(module);
        nft.forgeMint(alice, bytes32(uint256(1)));

        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);

        vm.prank(module);
        nft.forgeMint(alice, bytes32(uint256(1))); // 1 burn → 1 forge
        assertEq(nft.totalForged(), 1);

        vm.expectRevert(PowMintNFTv3_1.NothingBurned.selector);
        vm.prank(module);
        nft.forgeMint(alice, bytes32(uint256(2))); // quota exhausted
    }

    function test_Forge_IdNamespaceSeedAndEvent() public {
        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);
        _enableModule(module);

        bytes32 seed = keccak256("crafted-seed");
        uint256 expectedId = nft.FORGE_ID_BASE();

        vm.expectEmit(true, true, false, true, address(nft));
        emit PowMintNFTv3_1.Forged(carol, expectedId, seed);

        vm.prank(module);
        nft.forgeMint(carol, seed);

        assertEq(nft.ownerOf(expectedId), carol);
        assertEq(nft.seedOf(expectedId), seed);
        assertFalse(nft.isFreeToken(expectedId), "forged is not free-tier");

        // second forge → next id in the namespace
        uint256 id2 = _mineW(nft, bob);
        vm.prank(bob);
        nft.burn(id2);
        vm.prank(module);
        nft.forgeMint(carol, bytes32(uint256(7)));
        assertEq(nft.ownerOf(nft.FORGE_ID_BASE() + 1), carol);
    }

    function test_Forge_ToZeroReverts() public {
        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);
        _enableModule(module);

        vm.expectRevert();
        vm.prank(module);
        nft.forgeMint(address(0), bytes32(uint256(1)));
    }

    function test_Forge_PauseInterplay() public {
        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id);
        _enableModule(module);
        nft.setForgePaused(true);

        vm.expectRevert(PowMintNFTv3_1.ForgePaused.selector);
        vm.prank(module);
        nft.forgeMint(carol, bytes32(uint256(1)));

        // forge pause does not affect regular mint or burn
        _mineW(nft, bob);
        assertGt(nft.totalMinted(), 1);

        nft.setForgePaused(false);
        vm.prank(module);
        nft.forgeMint(carol, bytes32(uint256(1)));
        assertEq(nft.totalForged(), 1);
    }

    function test_SetModule_OnlyOwnerAndZeroGuard() public {
        vm.expectRevert(PowMintNFTv3_1.NotOwnerRole.selector);
        vm.prank(alice);
        nft.setModule(module, true);

        vm.expectRevert(PowMintNFTv3_1.ZeroAddress.selector);
        nft.setModule(address(0), true);

        nft.setModule(module, true);
        assertTrue(nft.authorizedModules(module));
    }

    function test_SetForgePaused_OnlyOwner() public {
        vm.expectRevert(PowMintNFTv3_1.NotOwnerRole.selector);
        vm.prank(alice);
        nft.setForgePaused(true);
    }

    // ======================================= circulating / quota invariants

    function test_Circulating_NeverExceedsMaxSupply() public {
        // Tiny instance: baseBits=4, epochSize=2, freeClaims=1, maxSupply=6.
        PowMintNFTv3_1 n = _deploy(4, 1e17, 2, 1, 6, 500, 0, 3, 60);
        _enableModuleLocal(n, module);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("c1")));
        n.addCodes(hs);

        _claimOn(n, alice, bytes32("c1")); // id 1
        for (uint256 i = 0; i < 5; ++i) {
            _mineW(n, address(uint160(0x2000 + i))); // ids 2..6
        }
        assertEq(n.totalMinted(), 6);
        assertEq(n.circulating(), 6);
        assertEq(n.circulating(), n.maxSupply());

        // burn 2, forge 2 → circulating back to the cap, then forge must stop
        vm.prank(alice);
        n.burn(1);
        vm.prank(address(uint160(0x2000)));
        n.burn(2);
        assertEq(n.circulating(), 4);

        vm.prank(module);
        n.forgeMint(carol, bytes32(uint256(11)));
        vm.prank(module);
        n.forgeMint(carol, bytes32(uint256(12)));
        assertEq(n.circulating(), 6);

        vm.expectRevert(PowMintNFTv3_1.NothingBurned.selector);
        vm.prank(module);
        n.forgeMint(carol, bytes32(uint256(13)));

        // price ladder untouched by all of the above
        assertEq(n.paidMinted(), 5);
    }

    function test_Quota_RecyclesViaForgedBurn() public {
        PowMintNFTv3_1 n = _deploy(4, 1e17, 2, 1, 6, 500, 0, 3, 60);
        _enableModuleLocal(n, module);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("c1")));
        n.addCodes(hs);
        _claimOn(n, alice, bytes32("c1")); // id 1
        _mineW(n, bob); // id 2

        vm.prank(alice);
        n.burn(1); // burned=1
        vm.prank(module);
        n.forgeMint(carol, bytes32(uint256(21))); // forged=1, id F
        uint256 forgedId = n.FORGE_ID_BASE();

        // burn the forged token → quota recycles
        vm.prank(carol);
        n.burn(forgedId);
        assertEq(n.totalBurned(), 2);

        vm.prank(module);
        n.forgeMint(carol, bytes32(uint256(22)));
        assertEq(n.totalForged(), 2);
        assertEq(n.circulating(), 2, "minted2 - burned2 + forged2");
    }

    // ======================================= L-01 / L-02 config guards

    /// L-01: a `maxSupply` that reaches the forge id namespace would collide with forged
    /// token ids → the constructor must reject it (BadConfig).
    function test_Constructor_MaxSupplyGeForgeIdBase_Reverts() public {
        uint256 fidBase = nft.FORGE_ID_BASE();
        vm.expectRevert(PowMintNFTv3_1.BadConfig.selector);
        _deploy(BASE_BITS, PRICE_START, EPOCH_SIZE, FREE_CLAIMS, fidBase, 500, 0, REG_WINDOW, PACE_TARGET);

        // one below the limit is still valid (isolates the >= FORGE_ID_BASE guard).
        PowMintNFTv3_1 ok =
            _deploy(BASE_BITS, PRICE_START, EPOCH_SIZE, FREE_CLAIMS, fidBase - 1, 500, 0, REG_WINDOW, PACE_TARGET);
        assertEq(ok.maxSupply(), fidBase - 1);
    }

    /// L-02: if the price ladder would overflow uint256 (priceStart << epochIndex), the
    /// explicit guard in `currentPrice()` reverts BadConfig instead of silently wrapping.
    function test_CurrentPrice_OverflowGuard_Reverts() public {
        // paidSupply huge enough that epochIndex can reach 200; epochSize 2 → need paidMinted 400.
        // priceStart = 1e18 ≈ 2^59.8, so 1e18 << 200 overflows uint256 (59.8 + 200 > 256).
        PowMintNFTv3_1 n = _deploy(BASE_BITS, 1e18, 2, 2, 1000, 500, 0, REG_WINDOW, PACE_TARGET);
        assertEq(n.currentPrice(), 1e18, "epoch 0 price");

        // jump the ladder via stdstore: e = paidMinted / epochSize = 400 / 2 = 200.
        stdstore.target(address(n)).sig("paidMinted()").checked_write(uint256(400));
        assertEq(n.epochIndex(), 200, "epoch jumped");

        vm.expectRevert(PowMintNFTv3_1.BadConfig.selector);
        n.currentPrice();
    }

    // ================================================= staking discount hook

    function test_Discount_OnlyModuleAndCap() public {
        // owner (this test) is NOT a module
        vm.expectRevert(PowMintNFTv3_1.NotModule.selector);
        nft.setStakingDiscount(carol, 1);

        _enableModule(module);

        vm.expectRevert(PowMintNFTv3_1.BadDiscount.selector);
        vm.prank(module);
        nft.setStakingDiscount(carol, 7);

        vm.prank(module);
        nft.setStakingDiscount(carol, 6);
        assertEq(nft.stakingDiscountBits(carol), 6);

        // floor = baseBits: discount can never push below it
        assertEq(nft.requiredBits(carol), BASE_BITS);

        vm.prank(module);
        nft.setStakingDiscount(carol, 0);
        assertEq(nft.stakingDiscountBits(carol), 0);
    }

    function test_Discount_EffectAboveFloor() public {
        // advance to epoch 1 (bits = base 8 + 2 = 10), alice keeps an active streak (+2)
        _mineW(nft, bob); // paid #0? no: paid #1 → epoch 0
        _mineW(nft, bob); // paid #2 → epoch 1
        assertEq(nft.epochIndex(), 1);

        // build a fresh active streak for alice with two quick mints
        vm.warp(block.timestamp + 400);
        _mineOnNoWarp(alice); // paid #3 (epoch 1)
        _mineOnNoWarp(alice); // paid #4 → epoch 2! recheck below
        // epoch moved to 2 → base bits = 8 + 4 = 12; alice streak active (+2… +4)
        uint256 bitsBefore = nft.requiredBits(alice);
        assertGt(bitsBefore, BASE_BITS + 2, "streak must lift difficulty above floor");

        _enableModule(module);
        vm.prank(module);
        nft.setStakingDiscount(alice, 6);
        assertEq(nft.requiredBits(alice), bitsBefore - 6, "discount applied");
    }

    function _mineOnNoWarp(address miner) internal {
        uint256 bits = nft.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(nft), miner, bits, _nonceCursor[miner]);
        _nonceCursor[miner] = nonce + 1;
        uint256 price = nft.currentPrice();
        vm.deal(miner, price + 1 ether);
        vm.prank(miner);
        nft.mint{value: price}(nonce);
    }

    function test_Discount_NotBelowBaseBitsAtHighEpoch() public {
        for (uint256 i = 0; i < 6; ++i) {
            _mineW(nft, address(uint160(0x3000 + i))); // push epoch to 3
        }
        assertEq(nft.epochIndex(), 3);

        _enableModule(module);
        vm.prank(module);
        nft.setStakingDiscount(carol, 6);

        // epoch-3 bits = 8 + 6 = 14; with −6 → 8 == baseBits floor
        assertEq(nft.requiredBits(carol), BASE_BITS);
    }

    // ==================================================== v3 regression

    function test_Royalty_And_Withdraw_Unchanged() public {
        (address recv, uint256 amt) = nft.royaltyInfo(0, 10_000);
        assertEq(recv, treasury);
        assertEq(amt, 500); // 5%

        uint256 id = _mineW(nft, alice);
        vm.prank(alice);
        nft.burn(id); // burn must not affect accounting

        uint256 bal = address(nft).balance;
        nft.withdraw();
        assertEq(treasury.balance, bal);
        assertEq(address(nft).balance, 0);
        assertEq(nft.totalWithdrawn(), bal);
    }

    function test_Ownership_TwoStep_Unchanged() public {
        nft.transferOwnership(nominee);
        assertEq(nft.owner(), owner); // not yet
        vm.prank(nominee);
        nft.acceptOwnership();
        assertEq(nft.owner(), nominee);
    }

    function test_ClaimAndFreeLock_Regression() public {
        bytes32[] memory hs = new bytes32[](2);
        hs[0] = keccak256(abi.encodePacked(bytes32("a")));
        hs[1] = keccak256(abi.encodePacked(bytes32("b")));
        nft.addCodes(hs);
        assertEq(nft.codesAvailable(), 2);

        uint256 id = _claimOn(nft, alice, bytes32("a"));
        assertEq(nft.claimsLeft(), 1);
        assertEq(nft.claimedCount(), 1);

        // advance to wave 5+ (epochSize=2 → need 8 paid mints)
        for (uint256 i = 0; i < 8; ++i) {
            _mineW(nft, address(uint160(0x4000 + i)));
        }
        assertGe(nft.currentWave(), 5);

        vm.prank(alice);
        nft.transferFrom(alice, bob, id); // unlocked now
        assertEq(nft.ownerOf(id), bob);
    }

    // ------------------------------------------------------- mint fee (v3.2)

    function _deployFee(uint256 feeBps) internal returns (PowMintNFTv3_1 n) {
        n = _deploy(BASE_BITS, PRICE_START, EPOCH_SIZE, FREE_CLAIMS, MAX_SUPPLY, 500, feeBps, REG_WINDOW, PACE_TARGET);
    }

    function _nonceFor(PowMintNFTv3_1 n, address miner) internal view returns (uint256) {
        return _findNonceFrom(address(n), miner, n.requiredBits(miner), 0);
    }

    function test_MintFee_250_ExactDueSucceeds() public {
        PowMintNFTv3_1 n = _deployFee(250);
        uint256 price = n.currentPrice();
        (uint256 due, uint256 fee) = n.currentMintDue();

        assertEq(fee, price * 250 / 10000, "fee = 2.5% of price");
        assertEq(due, price + fee, "due = price + fee");

        uint256 nonce = _nonceFor(n, alice);
        vm.deal(alice, due);
        vm.prank(alice);
        n.mint{value: due}(nonce);

        assertEq(n.totalMinted(), 1);
        assertEq(n.totalPaid(), due, "totalPaid == due");
        assertEq(n.totalFees(), fee, "totalFees == fee");
        assertEq(address(n).balance, due, "contract holds exactly due");
    }

    function test_MintFee_250_PriceOnlyReverts() public {
        PowMintNFTv3_1 n = _deployFee(250);
        (uint256 due,) = n.currentMintDue();
        uint256 nonce = _nonceFor(n, alice);

        vm.deal(alice, due);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3_1.WrongPayment.selector, PRICE_START, due));
        n.mint{value: PRICE_START}(nonce);
    }

    function test_MintFee_250_OverpayReverts() public {
        PowMintNFTv3_1 n = _deployFee(250);
        (uint256 due,) = n.currentMintDue();
        uint256 nonce = _nonceFor(n, alice);

        vm.deal(alice, due + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3_1.WrongPayment.selector, due + 1, due));
        n.mint{value: due + 1}(nonce);
    }

    function test_MintFee_250_DueTracksEpoch() public {
        PowMintNFTv3_1 n = _deployFee(250);
        uint256 nonce = _nonceFor(n, alice);
        (uint256 due,) = n.currentMintDue();
        vm.deal(alice, due);
        vm.prank(alice);
        n.mint{value: due}(nonce); // epoch 0 accepted at its exact due

        // second paid mint crosses epochSize=2 boundary → price (and due) doubles.
        _mineFee(n, bob, 0);
        (uint256 due1, uint256 fee1) = n.currentMintDue();
        assertEq(n.currentPrice(), 2 * PRICE_START, "epoch advanced");
        assertEq(fee1, (2 * PRICE_START) * 250 / 10000, "fee tracks new price");
        assertEq(due1, 2 * PRICE_START + fee1, "due tracks new price");
    }

    function test_MintFee_Zero_OldBehaviourUnchanged() public {
        assertEq(nft.mintFeeBps(), 0, "main instance fee-less");
        (uint256 due, uint256 fee) = nft.currentMintDue();
        assertEq(fee, 0);
        assertEq(due, nft.currentPrice());

        uint256 id = _mineW(nft, alice); // pays exactly price
        assertGt(id, 0);
        assertEq(nft.totalFees(), 0, "no fee accrued at 0 bps");
    }

    function test_Constructor_MintFeeCap() public {
        vm.expectRevert(PowMintNFTv3_1.BadConfig.selector);
        _deployFee(1001);

        PowMintNFTv3_1 ok = _deployFee(1000);
        assertEq(ok.mintFeeBps(), 1000);
        assertEq(ok.MAX_MINT_FEE_BPS(), 1000);
    }

    function test_Claim_NotChargedFee() public {
        PowMintNFTv3_1 n = _deployFee(250);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("feecode")));
        n.addCodes(hs);

        // claim still requires msg.value == 0 despite a live mint fee
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3_1.WrongPayment.selector, 1, 0));
        n.claim{value: 1}(bytes32("feecode"));

        vm.prank(alice);
        n.claim(bytes32("feecode"));
        assertEq(n.totalMinted(), 1);
        assertEq(n.totalPaid(), 0, "no payment on claim");
        assertEq(n.totalFees(), 0, "no fee on claim");
    }

    function _mineFee(PowMintNFTv3_1 n, address miner, uint256 start) internal returns (uint256 tokenId) {
        uint256 nonce = _findNonceFrom(address(n), miner, n.requiredBits(miner), start);
        (uint256 due,) = n.currentMintDue();
        vm.deal(miner, due);
        vm.prank(miner);
        n.mint{value: due}(nonce);
        tokenId = n.totalMinted();
    }

    // =============================================== v3.3 anti-sybil delta

    /// v3.3: cooldown is a FLAT schedule by streak level (5/10/15/20/25 min), capped at 25,
    /// with no wave multiplication. Each in-window mint escalates the streak by one level.
    function test_V33_CooldownScheduleByStreakLevel() public {
        // Large epochSize / regWindow isolate the streak layer (no epoch bits, regulator flat).
        PowMintNFTv3_1 s = _deploy(4, 1e17, 100, 1, 220, 500, 0, 100, 60);
        vm.deal(alice, 1000 ether);

        uint256[6] memory levelSecs = [uint256(300), 600, 900, 1200, 1500, 1500];

        assertEq(s.cooldown(alice), 0, "no streak -> 0");

        for (uint256 i; i < 6; ++i) {
            _mineNow(s, alice); // no warp → always inside the window → streak escalates
            assertEq(s.streakBits(alice), (i + 1) * 2, "streak level");
            assertEq(s.cooldown(alice), levelSecs[i], "cooldown by streak level");
        }
        // level 6 (streakBits 12) stays capped at 25 minutes.
        assertEq(s.cooldown(alice), 1500, "capped at 25 min");
    }

    /// v3.3: a wallet at streak level N stays hot for its level-N window and resets after it.
    function test_V33_StreakResetsAfterWindowElapses() public {
        PowMintNFTv3_1 s = _deploy(4, 1e17, 100, 1, 220, 500, 0, 100, 60);
        vm.deal(alice, 1000 ether);

        _mineNow(s, alice); // level 1
        _mineNow(s, alice); // still inside the 5-min window → level 2
        assertEq(s.streakBits(alice), 4);
        assertEq(s.cooldown(alice), 600, "level 2 = 10 min");
        assertTrue(s.streakActive(alice));

        uint256 last = block.timestamp;

        vm.warp(last + 599);
        assertTrue(s.streakActive(alice), "hot just before the 10-min boundary");
        assertEq(s.requiredBits(alice), 4 + 4, "base + streak while hot");

        vm.warp(last + 600);
        assertFalse(s.streakActive(alice), "cold at the 10-min boundary");
        assertEq(s.requiredBits(alice), 4, "streak dropped to base");

        // the next mint resets then re-extends from level 0 → level 1 (5-min window).
        _mineNow(s, alice);
        assertEq(s.streakBits(alice), 2, "reset then re-extend");
        assertEq(s.cooldown(alice), 300, "back to 5 min");
    }

    /// v3.3: pace regulator with regWindow=5 / paceTarget=25 uses an ASYMMETRIC step —
    /// +2 bits on a fast window, −1 bit on a slow window.
    function test_V33_Regulator_AsymmetricStep() public {
        // baseBits=8, epochSize=100 (epoch stays 0), regWindow=5, paceTarget=25.
        PowMintNFTv3_1 r = _deploy(8, 1e17, 100, 1, 220, 500, 0, 5, 25);
        assertEq(r.regWindow(), 5, "window default");
        assertEq(r.paceTargetS(), 25, "target default");
        assertEq(r.loadAdjust(), 0);

        // FAST window: 5 back-to-back mints (avg 0 < 0.8*25 = 20) → +2 bits.
        for (uint256 i; i < 5; ++i) {
            _mineNow(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 2, "fast window tightens by +2");

        // a second fast window adds another +2 (contrast with the −1 step below).
        for (uint256 i = 5; i < 10; ++i) {
            _mineNow(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 4, "second fast window: +2 again");

        // SLOW window: 5 mints spaced 1000s (avg 1000 > 1.2*25 = 30) → −1 bit.
        uint256 t = block.timestamp;
        for (uint256 i = 10; i < 15; ++i) {
            t += 1000;
            vm.warp(t);
            _mineNow(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 3, "slow window loosens by -1");
    }

    // ---------------------------------------------------------------- misc

    function _miner(uint256 i) internal pure returns (address) {
        return address(uint160(0x9000 + i));
    }

    /// @dev Grind-mint on `n` at the current timestamp (no warp): builds streaks and fills
    ///      regulator windows fast (used by the v3.3 delta tests).
    function _mineNow(PowMintNFTv3_1 n, address miner) internal returns (uint256 tokenId) {
        uint256 bits = n.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(n), miner, bits, _nonceCursor[miner]);
        _nonceCursor[miner] = nonce + 1;
        (uint256 due,) = n.currentMintDue();
        vm.deal(miner, due + 1 ether);
        vm.prank(miner);
        n.mint{value: due}(nonce);
        tokenId = n.totalMinted();
    }

    function _enableModuleLocal(PowMintNFTv3_1 n, address m) internal {
        n.setModule(m, true);
    }
}
