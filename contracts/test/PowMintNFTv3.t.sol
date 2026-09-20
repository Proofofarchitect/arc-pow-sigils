// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFTv3} from "../src/PowMintNFTv3.sol";

contract PowMintNFTv3Test is Test {
    PowMintNFTv3 nft;

    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address treasury = address(0xFEE);

    string constant BASE = "https://t/x/api/";

    // Main test instance: baseBits=8, epochSize=2, paidSupply=20 → 10 waves.
    uint8 constant BASE_BITS = 8;
    uint256 constant PRICE_START = 1e17;
    uint256 constant EPOCH_SIZE = 2;
    uint256 constant FREE_CLAIMS = 2;
    uint256 constant MAX_SUPPLY = 22;
    uint256 constant REG_WINDOW = 3;
    uint256 constant PACE_TARGET = 60;

    function setUp() public {
        nft = _deploy(BASE_BITS, PRICE_START, EPOCH_SIZE, FREE_CLAIMS, MAX_SUPPLY, 500, REG_WINDOW, PACE_TARGET);
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
        uint256 regWindow_,
        uint256 paceTargetS_
    ) internal returns (PowMintNFTv3) {
        return new PowMintNFTv3(
            "POVA", "PV3", treasury, BASE,
            baseBits_, priceStart_, epochSize_, freeClaims_, maxSupply_, royaltyBps_, regWindow_, paceTargetS_
        );
    }

    // ------------------------------------------------------------- helpers
    // NOTE: helpers hash locally (no external calls) so they never consume vm.prank,
    // and double as an off-chain reference for the contract's preimage layout.

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

    /// @dev Per-miner nonce cursor so repeated mints never collide on a used nonce.
    mapping(address => uint256) private _nonceCursor;

    /// @dev Fund the miner, grind a valid nonce for the CURRENT requiredBits, mint at currentPrice.
    function _mineOn(PowMintNFTv3 n, address miner) internal returns (uint256 tokenId) {
        uint256 bits = n.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(n), miner, bits, _nonceCursor[miner]);
        _nonceCursor[miner] = nonce + 1;

        uint256 price = n.currentPrice();
        vm.deal(miner, price + 1 ether);
        vm.prank(miner);
        n.mint{value: price}(nonce);
        tokenId = n.totalMinted();
    }

    function _claimOn(PowMintNFTv3 n, address who, bytes32 code) internal returns (uint256 tokenId) {
        vm.prank(who);
        n.claim(code);
        tokenId = n.totalMinted();
    }

    function _codeHash(bytes32 code) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(code));
    }

    function _miner(uint256 i) internal pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    // ============================================================ 1. price

    function test_PriceLadder_NoCap() public {
        assertEq(nft.currentPrice(), 1e17, "wave1 price");

        _mineOn(nft, _miner(1)); // paid#1 → epoch0
        assertEq(nft.currentPrice(), 1e17, "still epoch0 after 1 paid");

        _mineOn(nft, _miner(2)); // paid#2 → epoch1
        assertEq(nft.currentPrice(), 2e17, "doubles at epoch1");

        _mineOn(nft, _miner(3)); // paid#3
        _mineOn(nft, _miner(4)); // paid#4 → epoch2
        assertEq(nft.currentPrice(), 4e17, "epoch2 = 4x");

        _mineOn(nft, _miner(5)); // paid#5
        _mineOn(nft, _miner(6)); // paid#6 → epoch3
        assertEq(nft.currentPrice(), 8e17, "epoch3 = 8x (no cap)");
        assertEq(nft.epochIndex(), 3);
        assertEq(nft.currentWave(), 4);
        // prices paid: 1e17,1e17 (epoch0), 2e17,2e17 (epoch1), 4e17,4e17 (epoch2)
        assertEq(nft.totalPaid(), 2 * (1e17 + 2e17 + 4e17));
    }

    // ============================================================ 2. claims

    function test_Claim_Flow_AndSeed() public {
        bytes32 c1 = bytes32("code-one");
        bytes32 c2 = bytes32("code-two");
        bytes32 c3 = bytes32("code-three");
        bytes32[] memory codes = new bytes32[](3);
        codes[0] = _codeHash(c1);
        codes[1] = _codeHash(c2);
        codes[2] = _codeHash(c3);
        nft.addCodes(codes);

        assertEq(nft.codesAvailable(), 3);
        assertEq(nft.claimsLeft(), 2);

        uint256 id = _claimOn(nft, carol, c1);
        assertEq(id, 1);
        assertEq(nft.ownerOf(1), carol);
        assertEq(nft.isFreeToken(1), true);
        assertEq(nft.claimedCount(), 1);
        assertEq(nft.codesAvailable(), 2);
        assertEq(nft.claimsLeft(), 1);
        assertEq(
            nft.seedOf(1),
            keccak256(abi.encodePacked("claim", block.chainid, address(nft), carol, c1))
        );
        // claims do NOT touch the paid economy
        assertEq(nft.paidMinted(), 0);
        assertEq(nft.epochIndex(), 0);
        assertEq(nft.currentPrice(), 1e17);

        // reused code → InvalidCode (still under freeClaims cap)
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.InvalidCode.selector);
        nft.claim(c1);

        // unknown code → InvalidCode
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.InvalidCode.selector);
        nft.claim(bytes32("nope"));

        // second valid claim exhausts the free budget
        _claimOn(nft, alice, c2);
        assertEq(nft.claimedCount(), 2);
        assertEq(nft.claimsLeft(), 0);

        // valid code, but budget exhausted → ClaimsOver
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.ClaimsOver.selector);
        nft.claim(c3);
    }

    function test_Claim_WrongPaymentRejected() public {
        bytes32 c = bytes32("x");
        bytes32[] memory codes = new bytes32[](1);
        codes[0] = _codeHash(c);
        nft.addCodes(codes);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.WrongPayment.selector);
        nft.claim{value: 1}(c);
    }

    function test_AddCodes_DedupsAndOwnerOnly() public {
        bytes32 c = bytes32("dup");
        bytes32[] memory codes = new bytes32[](2);
        codes[0] = _codeHash(c);
        codes[1] = _codeHash(c);
        nft.addCodes(codes);
        assertEq(nft.codesAvailable(), 1, "duplicate hash not double-counted");
        assertEq(nft.codeStatus(_codeHash(c)), 1);

        bytes32[] memory more = new bytes32[](1);
        more[0] = _codeHash(c);
        nft.addCodes(more); // re-add is a no-op
        assertEq(nft.codesAvailable(), 1);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.addCodes(codes);
    }

    // ========================================================= 3. sold out

    function test_PaidSoldOut() public {
        // Tiny, cheap instance: paidSupply = 4.
        PowMintNFTv3 small = _deploy(1, 1, 2, 1, 5, 500, 3, 60);
        for (uint256 i = 1; i <= 4; ++i) {
            address m = _miner(i);
            vm.deal(m, 1 ether);
            _mineOn(small, m);
        }
        assertEq(small.paidMinted(), 4);
        assertEq(small.totalMinted(), 4);
        // post-sellout: wave/price frozen at the LAST real wave (not one past it)
        assertEq(small.currentWave(), 2);
        assertEq(small.currentPrice(), 2);

        address m5 = _miner(5);
        vm.deal(m5, 1 ether);
        uint256 nonce = _findNonceFor(address(small), m5, 1);
        vm.prank(m5);
        vm.expectPartialRevert(PowMintNFTv3.SoldOut.selector);
        small.mint(nonce);
    }

    // ============================================================= 4. lock

    function test_FreeTokenLock_UntilWave5() public {
        bytes32 c = bytes32("locked");
        bytes32[] memory codes = new bytes32[](1);
        codes[0] = _codeHash(c);
        nft.addCodes(codes);
        _claimOn(nft, alice, c); // tokenId 1, free

        assertEq(nft.currentWave(), 1);
        assertEq(nft.isFreeToken(1), true);

        // transferFrom blocked
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        nft.transferFrom(alice, bob, 1);

        // safeTransferFrom blocked (funnels through the override)
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        nft.safeTransferFrom(alice, bob, 1);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        nft.safeTransferFrom(alice, bob, 1, "");

        // advance to wave 5: paidMinted >= 4*epochSize = 8
        for (uint256 i = 0; i < 8; ++i) {
            vm.deal(_miner(i), 1000 ether);
            _mineOn(nft, _miner(i));
        }
        assertEq(nft.paidMinted(), 8);
        assertEq(nft.currentWave(), 5);

        // transfers now allowed
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);

        vm.prank(bob);
        nft.safeTransferFrom(bob, carol, 1);
        assertEq(nft.ownerOf(1), carol);
    }

    // =========================================================== 5. streak

    function test_Streak_PenaltyAndReset() public {
        // Large epochSize so epoch difficulty is frozen at 0 across the test.
        PowMintNFTv3 s = _deploy(8, 1e17, 100, 1, 220, 500, 100, 60);
        vm.deal(alice, 1000 ether);

        assertEq(s.requiredBits(alice), 8, "base");

        _mineOn(s, alice);
        assertEq(s.requiredBits(alice), 10, "+2 after 1st");

        _mineOn(s, alice);
        assertEq(s.requiredBits(alice), 12, "+4 after 2nd");

        _mineOn(s, alice);
        assertEq(s.requiredBits(alice), 14, "+6 after 3rd");
        assertEq(s.mintCount(alice), 3);

        // beyond cooldown → penalty drops back to base
        vm.warp(block.timestamp + 61);
        assertEq(s.requiredBits(alice), 8, "reset after cooldown");
        assertEq(s.streakActive(alice), false);
    }

    function test_Streak_CooldownGrowsWithWave() public {
        assertEq(nft.cooldown(alice), 60, "wave1 cooldown");

        _mineOn(nft, alice); // paid#1, wave still 1, streak=2
        assertEq(nft.requiredBits(alice), 10);
        assertEq(nft.cooldown(alice), 60);

        _mineOn(nft, alice); // paid#2 → wave2, epoch+2, streak=4
        assertEq(nft.currentWave(), 2);
        assertEq(nft.cooldown(alice), 120, "wave2 cooldown doubles");
        assertEq(nft.requiredBits(alice), 8 + 2 + 4, "base+epoch+streak");

        uint256 lastMint = block.timestamp;

        // 61s later: would have expired at wave1, but still hot at wave2
        vm.warp(lastMint + 61);
        assertEq(nft.streakActive(alice), true, "still hot (61 < 120)");
        assertEq(nft.requiredBits(alice), 14);

        // at the wave2 cooldown boundary the streak goes cold
        vm.warp(lastMint + 120);
        assertEq(nft.streakActive(alice), false, "cold at 120");
        assertEq(nft.requiredBits(alice), 10, "base + epoch only");
    }

    // ======================================================== 6. regulator

    function test_Regulator_TightenThenLoosen() public {
        PowMintNFTv3 r = _deploy(8, 1e17, 100, 1, 220, 500, 3, 60);

        assertEq(r.loadAdjust(), 0);

        // fast window: 3 mints with no warp → avg=0 < 0.8*target → tighten
        for (uint256 i = 1; i <= 3; ++i) {
            vm.deal(_miner(i), 1000 ether);
            _mineOn(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 1, "tightened");
        assertEq(r.requiredBits(_miner(4)), 8 + 1, "loadAdjust feeds requiredBits");

        // slow window: window start at m4, m6 at +200000s → avg ≈ 66666s >> 1.2*target → loosen
        uint256 t = block.timestamp;
        for (uint256 i = 4; i <= 6; ++i) {
            vm.deal(_miner(i), 1000 ether);
            t += 100_000;
            vm.warp(t);
            _mineOn(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 0, "loosened to floor");
        assertEq(r.requiredBits(_miner(7)), 8, "floor never goes below base");

        // a second slow window confirms the floor (never negative)
        for (uint256 i = 7; i <= 9; ++i) {
            vm.deal(_miner(i), 1000 ether);
            t += 100_000;
            vm.warp(t);
            _mineOn(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 0, "still floor");
    }

    function test_Regulator_HoldsInsideDeadZone() public {
        PowMintNFTv3 r = _deploy(8, 1e17, 100, 1, 220, 500, 2, 60);

        // Prime the regulator by tightening once (fast window, avg=0).
        for (uint256 i = 1; i <= 2; ++i) {
            vm.deal(_miner(i), 1000 ether);
            _mineOn(r, _miner(i));
        }
        assertEq(r.loadAdjust(), 1);

        // Window start at m3; m4 lands 120s later → elapsed 120 / 2 = 60s avg,
        // inside the ±20% dead zone [48,72] → loadAdjust holds.
        uint256 t = block.timestamp;
        vm.deal(_miner(3), 1000 ether);
        _mineOn(r, _miner(3));
        t += 120;
        vm.warp(t);
        vm.deal(_miner(4), 1000 ether);
        _mineOn(r, _miner(4));

        assertEq(r.loadAdjust(), 1, "dead zone holds");
    }

    // ========================================================= 7. bit model

    function test_RequiredBits_CombinesLayers() public {
        // regWindow large → loadAdjust stays 0, isolating base/epoch/streak layers.
        PowMintNFTv3 c = _deploy(8, 1e17, 2, 1, 5, 500, 100, 60);
        vm.deal(alice, 1000 ether);

        // base only
        assertEq(c.requiredBits(alice), uint8(8));

        // + epoch layer: push paidMinted to epoch1 via two distinct miners
        _mineOn(c, _miner(1));
        _mineOn(c, _miner(2));
        assertEq(c.epochIndex(), 1);
        assertEq(c.requiredBits(_miner(3)), uint8(8 + 2 * 1 + 0));

        // + streak layer: same wallet minting again inside the window
        _mineOn(c, _miner(3));
        assertEq(c.requiredBits(_miner(3)), uint8(8 + 2 * 1 + 0 + 2));
    }

    // ======================================================= 8. v2-parity

    function test_Pause_BlocksMintAndClaim() public {
        bytes32 c = bytes32("p");
        bytes32[] memory codes = new bytes32[](1);
        codes[0] = _codeHash(c);
        nft.addCodes(codes);

        nft.setPaused(true);

        uint256 nonce = _findNonceFor(address(nft), alice, 8);
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.MintPaused.selector);
        nft.mint{value: 1e17}(nonce);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.MintPaused.selector);
        nft.claim(c);

        nft.setPaused(false);
        _mineOn(nft, alice);
        assertEq(nft.ownerOf(1), alice);
    }

    function test_OnlyOwner_AdminFunctions() public {
        vm.startPrank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setPaused(true);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setBaseURI("x");
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.transferOwnership(bob);
        vm.stopPrank();
    }

    function test_TransferOwnership_AndZeroAddress() public {
        vm.expectPartialRevert(PowMintNFTv3.ZeroAddress.selector);
        nft.transferOwnership(address(0));

        // two-step (audit M-03): nomination changes nothing until accepted
        nft.transferOwnership(bob);
        assertEq(nft.owner(), owner, "owner unchanged after nominate");
        assertEq(nft.pendingOwner(), bob, "bob nominated");

        vm.prank(bob);
        nft.acceptOwnership();
        assertEq(nft.owner(), bob, "owner is bob after accept");
        assertEq(nft.pendingOwner(), address(0), "pending cleared");

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setPaused(true);
    }

    function test_transferOwnershipNominatesOnly() public {
        vm.expectEmit(true, true, false, false, address(nft));
        emit PowMintNFTv3.OwnershipTransferStarted(owner, bob);
        nft.transferOwnership(bob);

        assertEq(nft.owner(), owner, "owner unchanged until accept");
        assertEq(nft.pendingOwner(), bob, "bob is pending owner");
    }

    function test_acceptOwnershipByPending() public {
        nft.transferOwnership(bob);

        vm.expectEmit(true, true, false, false, address(nft));
        emit PowMintNFTv3.OwnershipTransferred(owner, bob);

        vm.prank(bob);
        nft.acceptOwnership();

        assertEq(nft.owner(), bob, "bob is owner");
        assertEq(nft.pendingOwner(), address(0), "pending cleared");

        // former owner loses admin rights
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setPaused(true);
    }

    function test_acceptOwnershipByNonPendingReverts() public {
        nft.transferOwnership(bob);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.acceptOwnership();

        assertEq(nft.owner(), owner, "owner unchanged");
        assertEq(nft.pendingOwner(), bob, "nomination intact");
    }

    function test_transferOwnershipToZeroReverts() public {
        vm.expectPartialRevert(PowMintNFTv3.ZeroAddress.selector);
        nft.transferOwnership(address(0));

        assertEq(nft.owner(), owner, "owner unchanged");
        assertEq(nft.pendingOwner(), address(0), "no nomination recorded");
    }

    function test_reNominationOverrides() public {
        nft.transferOwnership(bob);
        nft.transferOwnership(alice);
        assertEq(nft.pendingOwner(), alice, "latest nomination wins");

        // superseded nominee cannot accept
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.acceptOwnership();

        // current nominee can
        vm.prank(alice);
        nft.acceptOwnership();
        assertEq(nft.owner(), alice, "alice is owner");
        assertEq(nft.pendingOwner(), address(0), "pending cleared");
    }

    function test_Withdraw_Permissionless() public {
        _mineOn(nft, alice); // price 1e17
        assertEq(address(nft).balance, 1e17);

        vm.prank(carol); // anyone can trigger
        nft.withdraw();
        assertEq(treasury.balance, 1e17);
        assertEq(address(nft).balance, 0);
    }

    function test_Withdraw_TotalWithdrawnAccounting() public {
        assertEq(nft.totalPaid(), 0, "totalPaid starts at 0");
        assertEq(nft.totalWithdrawn(), 0, "totalWithdrawn starts at 0");

        _mineOn(nft, alice); // 1e17
        _mineOn(nft, alice); // 1e17 (same wave)
        assertEq(nft.totalPaid(), 2e17, "totalPaid accumulates");
        assertEq(address(nft).balance, 2e17);

        vm.prank(carol);
        nft.withdraw();
        assertEq(treasury.balance, 2e17, "treasury received the full balance");
        assertEq(nft.totalWithdrawn(), 2e17, "totalWithdrawn tracks the sweep");
        assertEq(nft.totalPaid(), 2e17, "totalPaid is cumulative, unchanged by withdraw");

        // Nothing left: a second permissionless sweep moves 0 and changes nothing.
        vm.prank(carol);
        nft.withdraw();
        assertEq(nft.totalWithdrawn(), 2e17, "counter unchanged on empty sweep");
        assertEq(treasury.balance, 2e17);
        assertEq(address(nft).balance, 0);
    }

    function test_Royalty() public {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 1e18);
        assertEq(receiver, treasury);
        assertEq(amount, 5e16); // 5%
        assertEq(nft.supportsInterface(0x2a55205a), true);
    }

    function test_TokenURI() public {
        _mineOn(nft, alice);
        assertEq(nft.tokenURI(1), string.concat(BASE, "1"));
        vm.expectRevert();
        nft.tokenURI(999);

        nft.setBaseURI("ipfs://new/");
        assertEq(nft.tokenURI(1), "ipfs://new/1");
    }

    function test_BelowFloor() public {
        uint256 weak = _findWeakNonceFor(address(nft), alice, 8);
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.BelowFloor.selector);
        nft.mint{value: 1e17}(weak);
    }

    function test_NonceUsed() public {
        uint256 bits = nft.requiredBits(alice);
        uint256 nonce = _findNonceFor(address(nft), alice, bits);
        vm.prank(alice);
        nft.mint{value: 1e17}(nonce);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NonceUsed.selector);
        nft.mint{value: 1e17}(nonce); // price still 1e17 (epoch0)
    }

    function test_WrongPayment_Mint() public {
        uint256 nonce = _findNonceFor(address(nft), alice, 8);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.WrongPayment.selector);
        nft.mint{value: 0}(nonce);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.WrongPayment.selector);
        nft.mint{value: 2e17}(nonce);

        vm.prank(alice);
        nft.mint{value: 1e17}(nonce);
        assertEq(nft.ownerOf(1), alice);
    }

    // -------------------------------------------------- config validation

    function test_Config_InvalidTreasury() public {
        vm.expectRevert(PowMintNFTv3.InvalidTreasury.selector);
        new PowMintNFTv3("P", "P", address(0), BASE, 8, 1e17, 2, 2, 22, 500, 3, 60);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(PowMintNFTv3.InvalidTreasury.selector);
        new PowMintNFTv3("P", "P", predicted, BASE, 8, 1e17, 2, 2, 22, 500, 3, 60);
    }

    function test_Config_BadConfig() public {
        // royaltyBps > 1000
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 2, 2, 22, 1001, 3, 60);
        // baseBits == 0
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 0, 1e17, 2, 2, 22, 500, 3, 60);
        // baseBits >= 250
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 250, 1e17, 2, 2, 22, 500, 3, 60);
        // priceStart == 0
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 0, 2, 2, 22, 500, 3, 60);
        // epochSize < 2
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 1, 2, 22, 500, 3, 60);
        // freeClaims < 1
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 2, 0, 22, 500, 3, 60);
        // maxSupply < freeClaims + 2*epochSize
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 2, 2, 5, 500, 3, 60);
        // regWindow < 2
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 2, 2, 22, 500, 1, 60);
        // paceTargetS < 1
        vm.expectRevert(PowMintNFTv3.BadConfig.selector);
        new PowMintNFTv3("P", "P", treasury, BASE, 8, 1e17, 2, 2, 22, 500, 3, 0);
    }

    function test_Config_ImmutablesAndDerived() public {
        assertEq(nft.paidSupply(), MAX_SUPPLY - FREE_CLAIMS);
        assertEq(nft.maxSupply(), MAX_SUPPLY);
        assertEq(nft.freeClaims(), FREE_CLAIMS);
        assertEq(nft.epochSize(), EPOCH_SIZE);
        assertEq(nft.baseBits(), BASE_BITS);
        assertEq(nft.treasury(), treasury);
        assertEq(nft.owner(), owner);
        assertEq(nft.currentWave(), 1);
    }
}
