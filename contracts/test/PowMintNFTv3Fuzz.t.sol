// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFTv3} from "../src/PowMintNFTv3.sol";

/// @title PowMintNFTv3Fuzz — fuzz + stateful invariant suite for Proof of Architect v3.
///
/// Structure mirrors test/PowMintNFTFuzz.t.sol (the v2 suite) but targets the
/// REAL v3 contract (src/PowMintNFTv3.sol). Two halves:
///
///   1) Stateless property fuzz tests (~20): PoW leading-zero bits / floor,
///      payment exactness, price ladder (no cap), nonce scoping, claim matrix,
///      requiredBits composition, free-token lock, pause/ownership, royalty,
///      withdraw, constructor validation.
///   2) Stateful invariant campaign against PowMintV3Handler: supply cap, claim
///      budget, balance accounting, monotone price, free-token lock window,
///      owner != 0, pause does not leak mints/claims.
///
/// v3 mechanics verified against source:
///   - work = keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce))  (104 bytes)
///   - valid iff leadingZeroBits(work) >= requiredBits = baseBits + 2*epochIndex + loadAdjust (+streak)
///   - price = priceStart << epochIndex ; epochIndex = paidMinted/epochSize, frozen at (paidSupply-1)/epochSize
///   - claim(code): codeHash = keccak256(abi.encodePacked(code)), must be pre-registered (addCodes)
///   - free tokens non-transferable while currentWave() < LOCK_WAVES (5)
///   - withdraw() is permissionless and sweeps the whole balance to the immutable treasury
///   - setPaused(true) blocks BOTH mint and claim (check is first in each)
///
/// PoW is never brute-forced at production difficulty: every instance uses a tiny
/// baseBits (1..4) so a valid nonce is found by scanning candidates in a bounded loop.

// ===========================================================================
// Invariant handler
// ===========================================================================

contract PowMintV3Handler is Test {
    PowMintNFTv3 public immutable nft;
    address public immutable deployOwner;

    address[] public actors;
    bytes32[] public codes;

    // ---- ghosts -----------------------------------------------------------
    uint256 public successfulMints; // paid mints that landed
    uint256 public claimedGhost; // claims that landed
    uint256 public totalPaidGhost; // sum of msg.value on successful mints
    uint256 public withdrawnGhost; // sum of balances swept by withdraw()
    uint256 public lastPriceGhost; // prior observed price (for monotonicity)

    bool public monotoneOk = true;
    bool public mintWhilePausedViolation;
    bool public claimWhilePausedViolation;
    bool public freeTransferBelowLockViolation;

    mapping(address => mapping(uint256 => bool)) public usedNonceGhost;
    mapping(uint256 => address) public claimerOf; // tokenId => original free claimer

    // Bounded proof-of-work search: a hash meeting > MAX_GRIND_BITS is skipped
    // (the regulator/streak can push difficulty arbitrarily high; grinding that
    // is pointless for the invariants and would blow up runtime).
    uint256 internal constant GRIND_LIMIT = 400_000;
    uint256 internal constant MAX_GRIND_BITS = 16;

    constructor(PowMintNFTv3 nft_, address owner_, bytes32[] memory codes_) {
        nft = nft_;
        deployOwner = owner_;
        for (uint256 i; i < 4; ++i) {
            actors.push(address(uint160(0x1000 + i)));
        }
        for (uint256 i; i < codes_.length; ++i) {
            codes.push(codes_[i]);
        }
        lastPriceGhost = nft_.currentPrice();
    }

    // ------------------------------------------------------------ views
    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function codeCount() external view returns (uint256) {
        return codes.length;
    }

    // -------------------------------------------------------- actions
    /// @dev Grind a valid, unused nonce for a random actor and try to mint at the
    ///      exact current price. If the contract is paused the call must revert.
    function tryMint(uint256 seed) external {
        if (nft.paidMinted() >= nft.maxSupply() - nft.freeClaims()) {
            _sync();
            return;
        }

        address miner = actors[seed % actors.length];
        uint8 need = nft.requiredBits(miner);
        if (need > MAX_GRIND_BITS) {
            _sync();
            return;
        }

        uint256 nonce;
        bool found;
        for (uint256 i; i < GRIND_LIMIT; ++i) {
            uint256 cand = uint256(keccak256(abi.encodePacked(seed, i)));
            if (usedNonceGhost[miner][cand]) continue;
            if (_lz(keccak256(abi.encodePacked(block.chainid, address(nft), miner, cand))) >= need) {
                nonce = cand;
                found = true;
                break;
            }
        }
        if (!found) {
            _sync();
            return;
        }

        uint256 price = nft.currentPrice();
        bool paused = nft.mintPaused();

        vm.deal(miner, price);
        vm.prank(miner);
        try nft.mint{value: price}(nonce) {
            if (paused) mintWhilePausedViolation = true;
            usedNonceGhost[miner][nonce] = true;
            successfulMints += 1;
            totalPaidGhost += price;
        } catch {}
        _sync();
    }

    /// @dev Redeem a random pre-registered code as a random actor.
    function claimFree(uint256 seed) external {
        if (nft.claimedCount() >= nft.freeClaims()) {
            _sync();
            return;
        }
        bytes32 code = codes[seed % codes.length];
        address who = actors[(seed >> 8) % actors.length];
        bool paused = nft.mintPaused();

        vm.prank(who);
        try nft.claim(code) {
            if (paused) claimWhilePausedViolation = true;
            claimedGhost += 1;
            claimerOf[nft.totalMinted()] = who;
        } catch {}
        _sync();
    }

    /// @dev Attempt to move a random token from its current owner to another actor.
    ///      A free token must never move while currentWave() < LOCK_WAVES.
    function attemptTransfer(uint256 seed) external {
        uint256 minted = nft.totalMinted();
        if (minted == 0) {
            _sync();
            return;
        }
        uint256 id = (seed % minted) + 1;
        address tokenOwner = nft.ownerOf(id);
        address dest = actors[(seed >> 8) % actors.length];
        if (dest == tokenOwner) dest = address(0xBEEF);

        bool isFree = nft.isFreeToken(id);
        uint256 wave = nft.currentWave();

        vm.prank(tokenOwner);
        try nft.transferFrom(tokenOwner, dest, id) {
            if (isFree && wave < 5) freeTransferBelowLockViolation = true;
        } catch {}
        _sync();
    }

    /// @dev Toggle pause as the CURRENT owner.
    function setPausedRandom(bool p) external {
        vm.prank(nft.owner());
        nft.setPaused(p);
        _sync();
    }

    /// @dev Two-step ownership handoff to a random non-zero actor.
    function rotateOwner(uint256 seed) external {
        address next = actors[seed % actors.length];
        vm.prank(nft.owner());
        nft.transferOwnership(next);
        vm.prank(next);
        nft.acceptOwnership();
        _sync();
    }

    /// @dev Permissionless sweep.
    function withdraw() external {
        uint256 bal = address(nft).balance;
        nft.withdraw();
        withdrawnGhost += bal;
        _sync();
    }

    /// @dev Move time forward (cooldowns, streaks, pace regulator).
    function advanceTime(uint256 secs) external {
        vm.warp(block.timestamp + (secs % 600));
        _sync();
    }

    // -------------------------------------------------------- internals
    function _sync() internal {
        uint256 p = nft.currentPrice();
        if (p < lastPriceGhost) monotoneOk = false;
        lastPriceGhost = p;
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

// ===========================================================================
// Test contract
// ===========================================================================

contract PowMintNFTv3FuzzTest is Test {
    PowMintNFTv3 internal nft; // general instance for stateless fuzz tests
    PowMintNFTv3 internal invNft; // instance driven by the invariant handler
    PowMintV3Handler internal handler;

    address internal owner = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCAC);
    address internal treasury = address(0xFEE);

    string internal constant BASE = "https://t/x/api/";

    function setUp() public {
        // General instance: baseBits=8, epochSize=2, paidSupply=20 -> 10 waves.
        nft = _deploy(8, 1e17, 2, 2, 22, 500, 3, 60);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);

        // Invariant instance: tiny difficulty, tiny waves, tiny price.
        // epochSize=2, freeClaims=2, maxSupply=12 => paidSupply=10 => wave can reach 5,
        // so the free-token lock window is actually crossable inside the campaign.
        invNft = _deploy(2, 1000, 2, 2, 12, 500, 3, 30);

        bytes32[] memory codes = new bytes32[](6);
        for (uint256 i; i < codes.length; ++i) {
            codes[i] = keccak256(abi.encodePacked("code-", i));
        }
        invNft.addCodes(_hashAll(codes));

        handler = new PowMintV3Handler(invNft, owner, codes);
        for (uint256 i; i < handler.actorCount(); ++i) {
            vm.deal(handler.actors(i), 100 ether);
        }
        vm.deal(address(handler), 1_000_000 ether);

        targetContract(address(handler));
    }

    // ------------------------------------------------------------- helpers

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
            "POVA",
            "PV3",
            treasury,
            BASE,
            baseBits_,
            priceStart_,
            epochSize_,
            freeClaims_,
            maxSupply_,
            royaltyBps_,
            regWindow_,
            paceTargetS_
        );
    }

    function _hashAll(bytes32[] memory raw) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            out[i] = keccak256(abi.encodePacked(raw[i]));
        }
    }

    function _addCode(PowMintNFTv3 n, bytes32 code) internal {
        bytes32[] memory h = new bytes32[](1);
        h[0] = keccak256(abi.encodePacked(code));
        n.addCodes(h);
    }

    /// @dev Mirror of the contract's leading-zero-bit counter (bitstring order).
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

    function _findWeakNonceFor(address target, address miner, uint256 bits) internal view returns (uint256) {
        uint256 n = 0;
        while (true) {
            if (_lz(_work(target, miner, n)) < bits) return n;
            n++;
        }
    }

    mapping(PowMintNFTv3 => mapping(address => uint256)) private _nonceCursor;

    function _mineOn(PowMintNFTv3 n, address miner) internal returns (uint256 tokenId) {
        uint256 bits = n.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(n), miner, bits, _nonceCursor[n][miner]);
        _nonceCursor[n][miner] = nonce + 1;

        uint256 price = n.currentPrice();
        vm.deal(miner, price + 1 ether);
        vm.prank(miner);
        n.mint{value: price}(nonce);
        tokenId = n.totalMinted();
    }

    /// @dev Independent re-derivation of the price the contract should report.
    function _expectedPrice(PowMintNFTv3 c, uint256 paid) internal view returns (uint256) {
        uint256 ps = c.maxSupply() - c.freeClaims();
        uint256 ep = paid >= ps ? (ps - 1) / c.epochSize() : paid / c.epochSize();
        return c.priceStart() << ep;
    }

    function _freshMiner(uint256 i) internal pure returns (address) {
        return address(uint160(0x20000 + i));
    }

    // =====================================================================
    // 1. PoW / leading-zero bits
    // =====================================================================

    /// @dev A nonce meeting the floor mints; any other nonce reverts with the
    ///      exact BelowFloor(got, need). Proves the leading-zero check end-to-end.
    function testFuzz_powFloorEnforced(uint256 nonce) public {
        PowMintNFTv3 c = _deploy(3, 1, 2, 1, 5, 500, 3, 60);
        address miner = address(uint160(uint256(keccak256(abi.encodePacked("miner", nonce)))));
        vm.deal(miner, 10);

        uint256 got = _lz(_work(address(c), miner, nonce));
        uint256 price = c.currentPrice();
        assertEq(price, 1, "price fixed at 1 wei");

        if (got >= 3) {
            vm.prank(miner);
            c.mint{value: price}(nonce);
            assertEq(c.ownerOf(1), miner);
            assertEq(c.nonceOf(1), nonce);
        } else {
            vm.prank(miner);
            vm.expectRevert(
                abi.encodeWithSelector(PowMintNFTv3.BelowFloor.selector, uint8(got), uint8(3))
            );
            c.mint{value: price}(nonce);
        }
    }

    /// @dev BelowFloor carries (gotBits, requiredBits) exactly, at a higher floor.
    function testFuzz_belowFloorReportsExactGot(uint256 start) public {
        start = bound(start, 0, type(uint256).max - 10_000);
        PowMintNFTv3 c = _deploy(8, 1e17, 2, 1, 20, 500, 100, 60);
        uint256 weak = _findWeakNonceFor(address(c), alice, 8);
        uint256 got = _lz(_work(address(c), alice, weak));
        assertLt(got, 8);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PowMintNFTv3.BelowFloor.selector, uint8(got), uint8(8))
        );
        c.mint{value: 1e17}(weak);
        // start is unused except to keep the fuzzer honest about arbitrary input
        assertLe(start, type(uint256).max);
    }

    function testFuzz_validNonceMintsAndStoresWork(uint256 seed) public {
        PowMintNFTv3 c = _deploy(2, 1, 2, 1, 9, 500, 100, 60);
        uint256 bits = c.requiredBits(alice);
        uint256 nonce = _findNonceFrom(address(c), alice, bits, seed % 500_000);
        bytes32 work = _work(address(c), alice, nonce);
        uint256 price = c.currentPrice();

        vm.prank(alice);
        c.mint{value: price}(nonce);

        assertEq(c.ownerOf(1), alice);
        assertEq(c.balanceOf(alice), 1);
        assertEq(c.seedOf(1), work);
        assertEq(c.nonceOf(1), nonce);
        assertTrue(c.nonceUsed(alice, nonce));
        assertEq(c.totalPaid(), price);
    }

    // =====================================================================
    // 2. Payment exactness
    // =====================================================================

    function testFuzz_mintWrongPaymentExact(uint256 sent) public {
        PowMintNFTv3 c = _deploy(3, 1, 2, 1, 9, 500, 3, 60);
        uint256 price = c.currentPrice(); // 1 wei
        sent = bound(sent, 0, 10 ether); // keep within the sender's balance
        vm.assume(sent != price);

        // Payment is checked BEFORE nonce/bits, so any nonce triggers it.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3.WrongPayment.selector, sent, price));
        c.mint{value: sent}(0);
    }

    function testFuzz_claimWrongPaymentExact(uint256 sent) public {
        sent = bound(sent, 0, 10 ether);
        vm.assume(sent != 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3.WrongPayment.selector, sent, uint256(0)));
        nft.claim{value: sent}(bytes32("x"));
    }

    // =====================================================================
    // 3. Price ladder (no cap)
    // =====================================================================

    function testFuzz_currentPriceMatchesFormula(uint256 n) public {
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 9, 500, 3, 60); // paidSupply = 8
        n = bound(n, 0, 8);
        uint256 prevPrice;

        for (uint256 i; i < n; ++i) {
            uint256 paid = c.paidMinted();
            uint256 expected = _expectedPrice(c, paid);
            assertEq(c.currentPrice(), expected, "price != formula");
            assertGe(c.currentPrice(), prevPrice, "price decreased");
            prevPrice = c.currentPrice();

            _mineOn(c, _freshMiner(i));
        }
        assertEq(c.totalMinted(), n);
        assertEq(c.currentPrice(), _expectedPrice(c, c.paidMinted()));
    }

    /// @dev At (and past) sell-out the wave/price freeze at the LAST real wave.
    function testFuzz_priceFreezesAtSellout(uint256 extra) public {
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 9, 500, 3, 60); // paidSupply = 8, epochSize = 2
        extra = bound(extra, 0, 20);

        for (uint256 i; i < 8; ++i) {
            _mineOn(c, _freshMiner(i));
        }
        assertEq(c.paidMinted(), 8);
        // (paidSupply-1)/epochSize = 7/2 = 3
        assertEq(c.epochIndex(), 3);
        assertEq(c.currentPrice(), uint256(1) << 3);

        // no further paid mint is possible
        uint256 bits = c.requiredBits(bob);
        uint256 nonce = _findNonceFrom(address(c), bob, bits, 0);
        uint256 price = c.currentPrice(); // read BEFORE prank + expectRevert
        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.SoldOut.selector);
        c.mint{value: price}(nonce + extra);
    }

    // =====================================================================
    // 4. Nonce handling
    // =====================================================================

    function testFuzz_nonceReuseReverts(uint256 seed) public {
        PowMintNFTv3 c = _deploy(2, 1, 2, 1, 9, 500, 100, 60);
        uint256 bits = c.requiredBits(alice);
        uint256 nonce = _findNonceFrom(address(c), alice, bits, seed % 100_000);
        uint256 price = c.currentPrice(); // read BEFORE prank

        vm.prank(alice);
        c.mint{value: price}(nonce);

        uint256 price2 = c.currentPrice(); // read BEFORE prank + expectRevert
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.NonceUsed.selector);
        c.mint{value: price2}(nonce);
    }

    function testFuzz_nonceIsWalletScoped(uint256 start) public {
        start = bound(start, 0, type(uint256).max - 20_000);
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 9, 500, 10, 60);

        uint256 common;
        bool ok;
        for (uint256 i; i < 8_000; ++i) {
            uint256 cand = start + i;
            if (_lz(_work(address(c), alice, cand)) >= 1 && _lz(_work(address(c), bob, cand)) >= 1) {
                common = cand;
                ok = true;
                break;
            }
        }
        if (!ok) return; // astronomically unlikely with baseBits = 1

        vm.prank(alice);
        c.mint{value: 1}(common);
        assertTrue(c.nonceUsed(alice, common));
        assertFalse(c.nonceUsed(bob, common));

        vm.prank(bob);
        c.mint{value: 1}(common);
        assertTrue(c.nonceUsed(bob, common));
        assertEq(c.totalMinted(), 2);
    }

    // =====================================================================
    // 5. Free claims
    // =====================================================================

    function testFuzz_claimUnknownCodeReverts(bytes32 code) public {
        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.InvalidCode.selector);
        nft.claim(code);
    }

    function testFuzz_claimValidThenReuseReverts(bytes32 code) public {
        _addCode(nft, code);

        vm.prank(alice);
        nft.claim(code);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.claimedCount(), 1);

        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.InvalidCode.selector);
        nft.claim(code); // consumed

        vm.prank(bob);
        vm.expectPartialRevert(PowMintNFTv3.InvalidCode.selector);
        nft.claim(bytes32(uint256(code) ^ 1)); // never registered
    }

    function testFuzz_claimBudgetEnforced(uint256 seed) public {
        PowMintNFTv3 c = _deploy(4, 1e17, 2, 2, 6, 500, 3, 60); // freeClaims = 2
        bytes32[] memory raw = new bytes32[](5);
        for (uint256 i; i < raw.length; ++i) {
            raw[i] = bytes32(uint256(keccak256(abi.encodePacked("budget", seed, i))) & 0xffff);
        }
        c.addCodes(_hashAll(raw));

        assertEq(c.claimsLeft(), 2);

        vm.prank(alice);
        c.claim(raw[0]);
        vm.prank(bob);
        c.claim(raw[1]);
        assertEq(c.claimedCount(), 2);
        assertEq(c.claimsLeft(), 0);

        vm.prank(carol);
        vm.expectPartialRevert(PowMintNFTv3.ClaimsOver.selector);
        c.claim(raw[2]);
    }

    function testFuzz_claimSeedAndFlag(bytes32 code) public {
        _addCode(nft, code);

        vm.prank(carol);
        nft.claim(code);

        assertTrue(nft.isFreeToken(1));
        assertEq(nft.claimedCount(), 1);
        assertEq(
            nft.seedOf(1),
            keccak256(abi.encodePacked("claim", block.chainid, address(nft), carol, code))
        );
        // claims never touch the paid economy
        assertEq(nft.paidMinted(), 0);
        assertEq(nft.epochIndex(), 0);
    }

    function testFuzz_duplicateCodeHashDedup(bytes32 code) public {
        bytes32 h = keccak256(abi.encodePacked(code));
        bytes32[] memory two = new bytes32[](2);
        two[0] = h;
        two[1] = h;
        nft.addCodes(two);

        assertEq(nft.codesAvailable(), 1);
        assertEq(nft.codeStatus(h), 1);
    }

    // =====================================================================
    // 6. requiredBits composition
    // =====================================================================

    /// @dev requiredBits == baseBits + 2*mintCount while epoch/load are frozen
    ///      and the streak cooldown has not expired.
    function testFuzz_requiredBitsStreak(uint256 mints) public {
        // epochSize and regWindow huge -> epoch layer and loadAdjust stay 0.
        PowMintNFTv3 c = _deploy(2, 1e17, 1000, 1, 3000, 500, 1000, 60);
        mints = bound(mints, 0, 6);

        uint256 prev = c.requiredBits(alice);
        for (uint256 i; i < mints; ++i) {
            _mineOn(c, alice);
            uint256 expected = uint256(c.baseBits()) + uint256(2) * c.mintCount(alice);
            if (expected > 250) expected = 250;
            assertEq(uint256(c.requiredBits(alice)), expected);
            assertGe(c.requiredBits(alice), prev);
            prev = c.requiredBits(alice);
        }
    }

    /// @dev requiredBits is capped at 250 and never below baseBits.
    function testFuzz_requiredBitsBounds(uint256 warpSecs) public {
        PowMintNFTv3 c = _deploy(4, 1e17, 2, 1, 24, 500, 3, 60);
        vm.warp(block.timestamp + (warpSecs % 1e6));
        for (uint256 i; i < 4; ++i) {
            assertGe(uint256(c.requiredBits(_freshMiner(i))), uint256(4));
            assertLe(uint256(c.requiredBits(_freshMiner(i))), uint256(250));
        }
    }

    // =====================================================================
    // 7. Free-token lock
    // =====================================================================

    function testFuzz_freeTokenLockedBeforeWave5(bytes32 code) public {
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 9, 500, 3, 60);
        _addCode(c, code);

        vm.prank(alice);
        c.claim(code);
        assertTrue(c.isFreeToken(1));
        assertLt(c.currentWave(), 5);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        c.transferFrom(alice, bob, 1);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        c.safeTransferFrom(alice, bob, 1);

        vm.prank(alice);
        vm.expectPartialRevert(PowMintNFTv3.FreeTokenLocked.selector);
        c.safeTransferFrom(alice, bob, 1, hex"1234");

        assertEq(c.ownerOf(1), alice, "locked token did not move");
    }

    /// @dev Once wave >= LOCK_WAVES, a free token transfers normally.
    function testFuzz_freeTokenUnlocksAtWave5(bytes32 code) public {
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 10, 500, 3, 60); // paidSupply = 9, epochSize = 2
        _addCode(c, code);

        vm.prank(alice);
        c.claim(code);
        assertTrue(c.isFreeToken(1));
        assertLt(c.currentWave(), 5);

        // wave 5 at paidMinted >= 4*epochSize = 8
        for (uint256 i; i < 8; ++i) {
            _mineOn(c, _freshMiner(i));
        }
        assertGe(c.currentWave(), 5);

        vm.prank(alice);
        c.transferFrom(alice, bob, 1);
        assertEq(c.ownerOf(1), bob);
        assertEq(c.balanceOf(bob), 1);
    }

    function testFuzz_paidTokenTransfersAtWave1(uint256 seed) public {
        PowMintNFTv3 c = _deploy(1, 1, 2, 1, 9, 500, 100, 60);
        uint256 nonce = _findNonceFrom(address(c), alice, c.requiredBits(alice), seed % 100_000);
        uint256 price = c.currentPrice(); // read BEFORE prank

        vm.prank(alice);
        c.mint{value: price}(nonce);
        assertFalse(c.isFreeToken(1));
        assertEq(c.currentWave(), 1);

        vm.prank(alice);
        c.transferFrom(alice, bob, 1);
        assertEq(c.ownerOf(1), bob);
    }

    // =====================================================================
    // 8. Pause / ownership / admin
    // =====================================================================

    function testFuzz_pauseBlocksMintAndClaim(bool paused) public {
        _addCode(nft, bytes32("pausecode"));
        nft.setPaused(paused);

        uint256 price = nft.currentPrice();
        uint256 nonce = _findNonceFrom(address(nft), alice, nft.requiredBits(alice), 0);

        if (paused) {
            vm.prank(alice);
            vm.expectPartialRevert(PowMintNFTv3.MintPaused.selector);
            nft.mint{value: price}(nonce);

            vm.prank(alice);
            vm.expectPartialRevert(PowMintNFTv3.MintPaused.selector);
            nft.claim(bytes32("pausecode"));
        } else {
            vm.prank(alice);
            nft.mint{value: price}(nonce);
            assertEq(nft.ownerOf(1), alice);

            vm.prank(bob);
            nft.claim(bytes32("pausecode"));
            assertEq(nft.ownerOf(2), bob);
        }
    }

    function testFuzz_transferOwnershipTwoStep(address nominee) public {
        vm.assume(nominee != address(0));
        vm.assume(nominee != address(0xDEAD));

        nft.transferOwnership(nominee);
        assertEq(nft.pendingOwner(), nominee);
        assertEq(nft.owner(), owner, "owner unchanged until accept");

        vm.prank(address(0xDEAD));
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.acceptOwnership();

        vm.prank(nominee);
        nft.acceptOwnership();
        assertEq(nft.owner(), nominee);
        assertEq(nft.pendingOwner(), address(0));
    }

    function testFuzz_nonOwnerAdminReverts(address caller) public {
        vm.assume(caller != owner);

        vm.startPrank(caller);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setPaused(true);
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.setBaseURI("ipfs://evil/");
        vm.expectPartialRevert(PowMintNFTv3.NotOwnerRole.selector);
        nft.transferOwnership(caller);
        vm.stopPrank();
    }

    // =====================================================================
    // 9. Royalty / withdraw
    // =====================================================================

    function testFuzz_royaltyAmount(uint256 salePrice) public view {
        salePrice = bound(salePrice, 0, type(uint128).max);
        (address recv, uint256 amount) = nft.royaltyInfo(1, salePrice);
        assertEq(recv, treasury);
        assertEq(amount, salePrice * uint256(nft.royaltyBps()) / 10_000);
    }

    function testFuzz_withdrawSweepsToTreasury(uint256 mints) public {
        PowMintNFTv3 c = _deploy(2, 1e17, 2, 1, 9, 500, 3, 60);
        mints = bound(mints, 0, 8);
        for (uint256 i; i < mints; ++i) {
            _mineOn(c, _freshMiner(i));
        }

        uint256 bal = address(c).balance;
        assertEq(bal, c.totalPaid());
        uint256 before = treasury.balance;

        vm.prank(carol); // permissionless
        c.withdraw();

        assertEq(address(c).balance, 0);
        assertEq(treasury.balance, before + bal);
    }

    // =====================================================================
    // 10. Constructor validation
    // =====================================================================

    function testFuzz_constructorBaseBitsBounds(uint8 baseBits) public {
        if (baseBits < 1 || baseBits >= 250) {
            vm.expectRevert(PowMintNFTv3.BadConfig.selector);
            new PowMintNFTv3("P", "P", treasury, BASE, baseBits, 1, 2, 1, 5, 500, 3, 60);
        } else {
            PowMintNFTv3 c = new PowMintNFTv3("P", "P", treasury, BASE, baseBits, 1, 2, 1, 5, 500, 3, 60);
            assertEq(c.baseBits(), baseBits);
        }
    }

    // =====================================================================
    // Invariants (stateful campaign over PowMintV3Handler)
    // =====================================================================

    /// @dev totalSupply <= maxSupply and equals the number of successful effects.
    function invariant_mintedEqualsGhostsAndCappedSupply() public view {
        assertEq(invNft.totalMinted(), handler.successfulMints() + handler.claimedGhost());
        assertLe(invNft.totalMinted(), invNft.maxSupply());
    }

    /// @dev Claims never exceed the free budget.
    function invariant_claimsWithinBudget() public view {
        assertEq(invNft.claimedCount(), handler.claimedGhost());
        assertLe(invNft.claimedCount(), invNft.freeClaims());
    }

    /// @dev Contract balance is exactly the unwithdrawn paid proceeds.
    function invariant_balanceAccounting() public view {
        assertEq(address(invNft).balance, handler.totalPaidGhost() - handler.withdrawnGhost());
        assertEq(invNft.totalPaid(), handler.totalPaidGhost());
    }

    /// @dev Price is non-decreasing over the whole run and matches the formula.
    function invariant_priceMonotoneAndExact() public view {
        assertTrue(handler.monotoneOk(), "price decreased");
        uint256 paid = invNft.paidMinted();
        uint256 ps = invNft.maxSupply() - invNft.freeClaims();
        uint256 ep = paid >= ps ? (ps - 1) / invNft.epochSize() : paid / invNft.epochSize();
        assertEq(invNft.currentPrice(), invNft.priceStart() << ep);
    }

    /// @dev A free token can only have moved once wave >= LOCK_WAVES.
    function invariant_freeTokenLock() public view {
        assertFalse(handler.freeTransferBelowLockViolation(), "free token moved while locked");
        uint256 wave = invNft.currentWave();
        for (uint256 id = 1; id <= invNft.totalMinted(); ++id) {
            if (invNft.isFreeToken(id) && wave < 5) {
                assertEq(invNft.ownerOf(id), handler.claimerOf(id), "locked free token changed owner");
            }
        }
    }

    function invariant_ownerNeverZero() public view {
        assertTrue(invNft.owner() != address(0));
    }

    /// @dev Pause must block mint AND claim (no successful effect while paused).
    function invariant_pauseBlocksMintAndClaim() public view {
        assertFalse(handler.mintWhilePausedViolation(), "mint succeeded while paused");
        assertFalse(handler.claimWhilePausedViolation(), "claim succeeded while paused");
    }

    /// @dev Every minted token is held by a known actor (or the transfer sink).
    function invariant_tokenBalancesSumToMinted() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += invNft.balanceOf(handler.actors(i));
        }
        sum += invNft.balanceOf(address(0xBEEF));
        assertEq(sum, invNft.totalMinted());
    }
}
