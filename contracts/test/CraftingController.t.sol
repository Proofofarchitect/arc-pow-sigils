// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {CraftingController} from "../src/CraftingController.sol";
import {PowMintNFTv3_1} from "../src/PowMintNFTv3_1.sol";
import {ERC721Minimal} from "../src/ERC721Minimal.sol";

/// @dev v1.1 test double for RarityRegistry's `bpsOf` (economy v1.1 spec §1/§4): per-key bps,
///      default 10000 (1.0×) when unset — keeps controller tests independent of the parallel
///      RarityRegistry implementation while exercising the exact same interface.
contract CraftMockRegistry {
    mapping(bytes32 => uint16) private _bps;

    function setBps(bytes32 cardKey, uint16 bps) external {
        _bps[cardKey] = bps;
    }

    function bpsOf(bytes32 cardKey) external view returns (uint16) {
        uint16 v = _bps[cardKey];
        return v == 0 ? 10000 : v;
    }
}

/// @dev v1.1 test double for BurnPoints' `accrue` (economy v1.1 spec §4).
contract MockBurnPoints {
    mapping(address => uint256) public points;
    uint256 public calls;

    function accrue(address to, uint256 amount) external {
        points[to] += amount;
        calls += 1;
    }
}

/// @title CraftingControllerTest — unit + integration suite for CraftingController v1
///        (`HC/2 spec` §3/§4/§6, red-team `red-team notes`).
///
/// All tests run against the real `PowMintNFTv3_1` core (grind-mints, baseBits=4) unless a
/// test explicitly deploys a differently-parameterised instance (e.g. the free-token wave
/// check needs a tiny `epochSize`).
contract CraftingControllerTest is Test {
    using stdStorage for StdStorage;

    CraftingController ctrl;
    PowMintNFTv3_1 core;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address nominee = address(0xBEEF);
    address treasury = address(0xFEE);

    string constant BASE = "https://t/x/api/";

    // default core: baseBits=4, epochSize=1000 → price stays at epoch 0 (=PRICE_START) for
    // every test here (we never mint ≥1000 paid tokens).
    uint8 constant BASE_BITS = 4;
    uint256 constant PRICE_START = 1e18;
    uint256 constant EPOCH_SIZE = 1000;
    uint256 constant FREE_CLAIMS = 2;
    uint256 constant MAX_SUPPLY = 3000;
    uint256 constant REG_WINDOW = 3;
    uint256 constant PACE_TARGET = 60;

    // -------------------------------------------------- frozen reference vector (HC/2 spec §1)
    // childSeed = keccak256(abi.encodePacked("PoA_CRAFT_v1", seedLow, seedHigh,
    //   uint256(minId), uint256(maxId), uint8 door, uint8 boostTier, uint64 craftNonce,
    //   bytes32 entropy)); computed off-chain with python3/pycryptodome and cross-checked
    // with `cast keccak`. Inputs: seedLow=0x11..11, seedHigh=0x22..22, minId=3, maxId=5,
    // door=0, boostTier=2, craftNonce=0, entropy=0xabcdef01..6789.
    bytes32 constant VEC_SEED_LOW = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 constant VEC_SEED_HIGH = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 constant VEC_ENTROPY = 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789;
    bytes32 constant VEC_CHILD = 0x75f86b9e8290a757948f35776c77f2b966773d40d7e36bc86657cdb43c1d7a0b;

    // a generic non-zero entropy used where the exact seed value does not matter.
    bytes32 constant ENTROPY = bytes32(uint256(0xE7E7));

    // W3-01 fix: on-chain preimage is keccak256(abi.encode(choices, salt)); tests use a fixed
    // non-zero client secret unless a test deliberately supplies a different one.
    bytes32 constant SALT = bytes32(uint256(0x5A17));
    bytes32 constant WRONG_SALT = bytes32(uint256(0xBAD5A17));

    function setUp() public {
        core = _deployCore(BASE_BITS, EPOCH_SIZE, FREE_CLAIMS, MAX_SUPPLY);
        ctrl = new CraftingController(address(core));
        core.setModule(address(ctrl), true);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    // ------------------------------------------------------------- helpers

    function _deployCore(uint8 baseBits_, uint256 epochSize_, uint256 freeClaims_, uint256 maxSupply_)
        internal
        returns (PowMintNFTv3_1)
    {
        return new PowMintNFTv3_1(
            "POVA",
            "PV31",
            treasury,
            BASE,
            baseBits_,
            PRICE_START,
            epochSize_,
            freeClaims_,
            maxSupply_,
            500,
            0,
            REG_WINDOW,
            PACE_TARGET
        );
    }

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

    function _findNonce(PowMintNFTv3_1 n, address miner, uint256 bits, uint256 start)
        internal
        view
        returns (uint256)
    {
        uint256 x = start;
        while (_lz(_work(address(n), miner, x)) < bits) {
            x++;
        }
        return x;
    }

    mapping(address => mapping(address => uint256)) private _cursor;

    /// @dev Grind-mint on `n` to `who` (warp +400s keeps the regulator at 0 / streak cold).
    function _mintTo(PowMintNFTv3_1 n, address who) internal returns (uint256 id) {
        vm.warp(block.timestamp + 400);
        uint256 bits = n.requiredBits(who);
        uint256 nonce = _findNonce(n, who, bits, _cursor[address(n)][who]);
        _cursor[address(n)][who] = nonce + 1;
        uint256 price = n.currentPrice();
        vm.deal(who, price);
        vm.prank(who);
        n.mint{value: price}(nonce);
        id = n.totalMinted();
    }

    /// @dev Mint two cards to `who` and approve the controller to escrow them.
    function _prepareTwo(PowMintNFTv3_1 n, CraftingController c, address who)
        internal
        returns (uint256 a, uint256 b)
    {
        a = _mintTo(n, who);
        b = _mintTo(n, who);
        vm.startPrank(who);
        n.approve(address(c), a);
        n.approve(address(c), b);
        vm.stopPrank();
    }

    function _seq(uint8 n, uint8 parent) internal pure returns (CraftingController.SlotChoice[] memory c) {
        c = new CraftingController.SlotChoice[](n);
        for (uint8 i; i < n; ++i) {
            c[i] = CraftingController.SlotChoice(i, parent);
        }
    }

    function _one(uint8 slot, uint8 parent) internal pure returns (CraftingController.SlotChoice[] memory c) {
        c = new CraftingController.SlotChoice[](1);
        c[0] = CraftingController.SlotChoice(slot, parent);
    }

    function _two(uint8 s0, uint8 p0, uint8 s1, uint8 p1)
        internal
        pure
        returns (CraftingController.SlotChoice[] memory c)
    {
        c = new CraftingController.SlotChoice[](2);
        c[0] = CraftingController.SlotChoice(s0, p0);
        c[1] = CraftingController.SlotChoice(s1, p1);
    }

    function _commit(
        CraftingController c,
        address who,
        uint256 a,
        uint256 b,
        CraftingController.SlotChoice[] memory choices,
        uint8 tier
    ) internal returns (uint256 id) {
        uint256 fee = c.feeFor(tier);
        vm.deal(who, fee);
        vm.prank(who);
        c.commit{value: fee}(a, b, keccak256(abi.encode(choices, SALT)), tier);
        id = c.lastCommitId();
    }

    function _commitBlockOf(CraftingController c, uint256 id) internal view returns (uint256) {
        (,,,,,, uint64 cb,,,) = c.commits(id);
        return cb;
    }

    function _reveal(
        CraftingController c,
        uint256 id,
        uint256 delta,
        bytes32 entropy,
        CraftingController.SlotChoice[] memory choices,
        address caller
    ) internal {
        uint256 cb = _commitBlockOf(c, id);
        vm.roll(cb + delta);
        if (entropy != bytes32(0)) vm.setBlockhash(cb + 2, entropy);
        vm.prank(caller);
        c.reveal(id, choices, SALT);
    }

    function _revealOk(CraftingController c, uint256 id, CraftingController.SlotChoice[] memory choices)
        internal
    {
        _reveal(c, id, 3, ENTROPY, choices, alice);
    }

    // ============================================================= timing

    function test_Reveal_TooEarly_Plus0_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb); // same block
        vm.expectRevert(CraftingController.OutsideWindow.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_TooEarly_Plus1_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 1);
        vm.expectRevert(CraftingController.OutsideWindow.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_TooEarly_Plus2_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 2); // entropy block itself — window opens only at +3 (F-01)
        vm.expectRevert(CraftingController.OutsideWindow.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_AtPlus3_Succeeds() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        _revealOk(ctrl, id, ch);

        (,,,,,,,, bool revealed,) = ctrl.commits(id);
        assertTrue(revealed, "revealed flag");
        assertEq(core.ownerOf(core.FORGE_ID_BASE()), alice, "child minted");
    }

    function test_Reveal_AtPlus258_NoEntropy_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        // last admissible block by the window, but the entropy block (cb+2) is now exactly
        // 256 blocks old → blockhash == 0 → NoEntropy.
        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 258);
        vm.setBlockhash(cb + 2, bytes32(0)); // pin blockhash to 0 for determinism
        vm.expectRevert(CraftingController.NoEntropy.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_AfterWindow_Plus259_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(CraftingController.OutsideWindow.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Refund_BeforeWindow_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 258); // window still open (last block)
        vm.expectRevert(CraftingController.WindowOpen.selector);
        vm.prank(alice);
        ctrl.refund(id);
    }

    // ============================================================= hashing

    function test_Reveal_HashMismatch_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory committed = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, committed, 0);

        CraftingController.SlotChoice[] memory different = _seq(3, 0); // 3 choices ≠ hash
        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(CraftingController.HashMismatch.selector);
        vm.prank(alice);
        ctrl.reveal(id, different, SALT);
    }

    function test_Commit_ZeroHash_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 fee = ctrl.feeFor(0);
        vm.deal(alice, fee);
        vm.expectRevert(CraftingController.BadHash.selector);
        vm.prank(alice);
        ctrl.commit{value: fee}(a, b, bytes32(0), 0);
    }

    // ============================================================= structural

    function test_Reveal_TooManyChoices_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(7, 0); // tier0 cap = 6
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.TooManyChoices.selector, 7));
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_SlotTooHigh_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _one(12, 0); // legendary is never choice-able
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.BadSlot.selector, 12));
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_SlotsNotIncreasing_Reverts() public {
        // [1, 0] → not strictly increasing
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _two(1, 0, 0, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(CraftingController.SlotsNotIncreasing.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_DuplicateSlot_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _two(2, 0, 2, 1); // duplicate slot
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(CraftingController.SlotsNotIncreasing.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Reveal_BadParent_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _one(0, 2); // parent must be 0/1
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.BadParent.selector, 2));
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_MaxChosen_PerTier() public view {
        assertEq(ctrl.maxChosen(0), 6);
        assertEq(ctrl.maxChosen(1), 8);
        assertEq(ctrl.maxChosen(2), 10);
        assertEq(ctrl.maxChosen(3), 12);
    }

    function test_Reveal_TwelveChoices_Tier3_Ok() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(12, 1); // full cap at tier3
        uint256 id = _commit(ctrl, alice, a, b, ch, 3);

        _revealOk(ctrl, id, ch);
        assertEq(core.ownerOf(core.FORGE_ID_BASE()), alice);
    }

    // ============================================================= fees

    function test_Fee_Math_AllTiers() public view {
        uint256 base = ctrl.CRAFT_FEE();
        assertEq(base, 5e18, "base craft fee = 5 USDC");
        assertEq(ctrl.craftFee(), base, "craftFee == CRAFT_FEE");
        assertEq(ctrl.feeFor(0), base);
        assertEq(ctrl.feeFor(1), base + PRICE_START / 2);
        assertEq(ctrl.feeFor(2), base + PRICE_START);
        assertEq(ctrl.feeFor(3), base + 2 * PRICE_START);
        assertEq(ctrl.boostCost(0), 0);
    }

    /// @dev base craft fee is fixed at 5 USDC and does NOT track `currentPrice()`: as waves
    ///      advance (and price doubles per wave) `craftFee()` stays constant while `boostCost`
    ///      keeps scaling with price.
    function test_Fee_BaseCraftFee_IndependentOfWaveAndPrice() public {
        // epochSize=2 → every 2 paid mints advance the wave and double currentPrice.
        PowMintNFTv3_1 c = _deployCore(BASE_BITS, 2, FREE_CLAIMS, 40);
        CraftingController cc = new CraftingController(address(c));

        assertEq(cc.craftFee(), 5e18, "wave 1: 5 USDC");
        assertEq(c.currentPrice(), PRICE_START, "wave 1 price = PRICE_START");

        for (uint256 i; i < 5; ++i) {
            _mintTo(c, address(uint160(0x6000 + i)));
        }

        assertGt(c.currentWave(), 1, "wave advanced");
        assertGt(c.currentPrice(), PRICE_START, "price rose with waves");
        assertEq(cc.craftFee(), 5e18, "craftFee still 5 USDC (price-independent)");
        assertEq(cc.feeFor(0), 5e18, "feeFor(0) = base only");
        assertEq(cc.feeFor(1), 5e18 + c.currentPrice() / 2, "feeFor(1) = base + boost");
    }

    function test_Commit_AllTiersCorrectFee_Ok() public {
        for (uint8 tier; tier <= 3; ++tier) {
            (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
            uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), tier);
            assertEq(id, ctrl.lastCommitId());
        }
        assertEq(ctrl.lastCommitId(), 4);
    }

    function test_Commit_WrongPayment_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 fee = ctrl.feeFor(2);

        vm.deal(alice, fee + 1);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.WrongPayment.selector, fee + 1, fee));
        vm.prank(alice);
        ctrl.commit{value: fee + 1}(a, b, keccak256(abi.encode(_seq(2, 0), SALT)), 2);

        vm.deal(alice, fee - 1);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.WrongPayment.selector, fee - 1, fee));
        vm.prank(alice);
        ctrl.commit{value: fee - 1}(a, b, keccak256(abi.encode(_seq(2, 0), SALT)), 2);
    }

    function test_Commit_SameCard_Reverts() public {
        (uint256 a,) = _prepareTwo(core, ctrl, alice);
        uint256 fee = ctrl.feeFor(0);
        vm.deal(alice, fee);
        vm.expectRevert(CraftingController.SameCard.selector);
        vm.prank(alice);
        ctrl.commit{value: fee}(a, a, keccak256(abi.encode(_seq(2, 0), SALT)), 0);
    }

    function test_Commit_BadTier_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 fee = ctrl.feeFor(3);
        vm.deal(alice, 100 ether);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.BadTier.selector, 4));
        vm.prank(alice);
        ctrl.commit{value: fee}(a, b, keccak256(abi.encode(_seq(2, 0), SALT)), 4);
    }

    // ============================================================= escrow / state

    function test_Commit_EscrowsCardsAndStoresRecord() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 nonceBefore = ctrl.craftNonce();
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 1);

        assertEq(core.ownerOf(a), address(ctrl), "cardA escrowed");
        assertEq(core.ownerOf(b), address(ctrl), "cardB escrowed");
        assertEq(ctrl.craftNonce(), nonceBefore + 1, "nonce incremented");

        (address player, uint256 ca, uint256 cb_, bytes32 ch, uint8 tier, uint64 nonce,,,,) = ctrl.commits(id);
        assertEq(player, alice);
        assertEq(ca, a);
        assertEq(cb_, b);
        assertEq(uint256(tier), 1);
        assertEq(uint256(nonce), nonceBefore);
        assertEq(ch, keccak256(abi.encode(_seq(2, 0), SALT)));
    }

    // ============================================================= childSeed

    function test_ChildSeed_MatchesHardcodedVector() public {
        // mint ids 1..5 to alice and pin the two parent seeds we craft from.
        for (uint256 i; i < 5; ++i) {
            _mintTo(core, alice);
        }
        assertEq(core.totalMinted(), 5);

        stdstore.target(address(core)).sig("seedOf(uint256)").with_key(3).checked_write(VEC_SEED_LOW);
        stdstore.target(address(core)).sig("seedOf(uint256)").with_key(5).checked_write(VEC_SEED_HIGH);

        vm.startPrank(alice);
        core.approve(address(ctrl), 3);
        core.approve(address(ctrl), 5);
        vm.stopPrank();

        // commit(cardA=5, cardB=3) → canonicalized to minId=3/seedLow, maxId=5/seedHigh.
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 fee = ctrl.feeFor(2);
        vm.deal(alice, fee);
        vm.prank(alice);
        ctrl.commit{value: fee}(5, 3, keccak256(abi.encode(ch, SALT)), 2);
        uint256 id = ctrl.lastCommitId();
        assertEq(ctrl.craftNonce() - 1, 0, "first commit: nonce 0");

        _reveal(ctrl, id, 3, VEC_ENTROPY, ch, alice);

        uint256 child = core.FORGE_ID_BASE();
        assertEq(core.seedOf(child), VEC_CHILD, "childSeed == frozen vector");
        assertEq(core.ownerOf(child), alice);
    }

    /// @dev Builds a fresh deployment, crafts cards (1,2) in the given order, and returns the
    ///      resulting childSeed. Entropy/ids/tier/nonce are held identical across calls.
    function _childFor(bool swap) internal returns (bytes32) {
        PowMintNFTv3_1 c = _deployCore(BASE_BITS, EPOCH_SIZE, FREE_CLAIMS, MAX_SUPPLY);
        CraftingController cc = new CraftingController(address(c));
        c.setModule(address(cc), true);

        uint256 lo = _mintTo(c, alice);
        uint256 hi = _mintTo(c, alice);
        stdstore.target(address(c)).sig("seedOf(uint256)").with_key(lo).checked_write(VEC_SEED_LOW);
        stdstore.target(address(c)).sig("seedOf(uint256)").with_key(hi).checked_write(VEC_SEED_HIGH);

        vm.startPrank(alice);
        c.approve(address(cc), lo);
        c.approve(address(cc), hi);
        vm.stopPrank();

        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 fee = cc.feeFor(2);
        vm.deal(alice, fee);
        vm.prank(alice);
        if (swap) {
            cc.commit{value: fee}(hi, lo, keccak256(abi.encode(ch, SALT)), 2);
        } else {
            cc.commit{value: fee}(lo, hi, keccak256(abi.encode(ch, SALT)), 2);
        }
        uint256 id = cc.lastCommitId();

        uint256 cb = _commitBlockOf(cc, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, VEC_ENTROPY);
        vm.prank(alice);
        cc.reveal(id, ch, SALT);

        return c.seedOf(c.FORGE_ID_BASE());
    }

    function test_ChildSeed_CanonicalParentOrder() public {
        bytes32 forward = _childFor(false);
        bytes32 reversed = _childFor(true);
        assertTrue(forward != bytes32(0), "childSeed set");
        assertEq(reversed, forward, "(A,B) and (B,A) give one childSeed");
    }

    // ============================================================= burn + forge

    function test_Reveal_BurnsTwiceForgeOnce() public {
        uint256 burned0 = core.totalBurned();
        uint256 forged0 = core.totalForged();

        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(4, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 1);
        _revealOk(ctrl, id, ch);

        assertEq(core.totalBurned(), burned0 + 2, "two burns");
        assertEq(core.totalForged(), forged0 + 1, "one forge");
        uint256 child = core.FORGE_ID_BASE() + forged0;
        assertEq(core.ownerOf(child), alice, "child owner");
        assertFalse(core.isFreeToken(child), "child not free-tier");

        vm.expectRevert(ERC721Minimal.NoToken.selector);
        core.ownerOf(a);
        vm.expectRevert(ERC721Minimal.NoToken.selector);
        core.ownerOf(b);
    }

    function test_Reveal_DoubleReveal_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        _revealOk(ctrl, id, ch);

        vm.expectRevert(CraftingController.AlreadySettled.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    function test_Refund_DoubleRefund_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id);

        vm.expectRevert(CraftingController.AlreadySettled.selector);
        vm.prank(alice);
        ctrl.refund(id);
    }

    function test_Reveal_AfterRefund_Reverts() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id);

        vm.expectRevert(CraftingController.AlreadySettled.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);
    }

    // ============================================================= permissionless

    function test_Reveal_Permissionless_ChildGoesToCommitter() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        // a third party (carol) reveals; the child still goes to alice (RT-6).
        _reveal(ctrl, id, 3, ENTROPY, ch, carol);

        assertEq(core.ownerOf(core.FORGE_ID_BASE()), alice, "child goes to committer");
        assertEq(core.balanceOf(carol), 0, "revealer gets nothing");
    }

    // ============================================================= refund

    function test_Refund_ReturnsCardsKeepsFees() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 0);
        uint256 fee = ctrl.feeFor(0);
        assertEq(address(ctrl).balance, fee, "fee held");

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id);

        assertEq(core.ownerOf(a), alice, "cardA returned");
        assertEq(core.ownerOf(b), alice, "cardB returned");
        assertEq(address(ctrl).balance, fee, "fee kept (anti-grind)");
        assertEq(alice.balance, 0, "no fee to committer");
    }

    function test_Refund_FullFeeWhenForgePaused() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 2);
        uint256 fee = ctrl.feeFor(2);

        core.setForgePaused(true); // protocol fault → full fee back (RT-5)

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id);

        assertEq(core.ownerOf(a), alice, "cardA returned");
        assertEq(core.ownerOf(b), alice, "cardB returned");
        assertEq(address(ctrl).balance, 0, "fee swept back");
        assertEq(alice.balance, fee, "full fee refunded");
    }

    function test_Refund_OnlyCommitter() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.expectRevert(CraftingController.NotCommitter.selector);
        vm.prank(bob);
        ctrl.refund(id);
    }

    function test_Refund_UnknownCommit_Reverts() public {
        vm.expectRevert(CraftingController.NoCommit.selector);
        vm.prank(alice);
        ctrl.refund(999);
    }

    // ============================================================= free-token lock

    function test_Commit_FreeTokenLockedPreWave5_Reverts() public {
        PowMintNFTv3_1 c = _deployCore(BASE_BITS, 2, FREE_CLAIMS, 40);
        CraftingController cc = new CraftingController(address(c));
        c.setModule(address(cc), true);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("free1")));
        c.addCodes(hs);
        vm.prank(alice);
        c.claim(bytes32("free1"));
        uint256 freeId = c.totalMinted();
        assertTrue(c.isFreeToken(freeId), "free token");
        assertLt(c.currentWave(), c.LOCK_WAVES(), "still locked");

        uint256 paid = _mintTo(c, alice);
        vm.startPrank(alice);
        c.approve(address(cc), freeId);
        c.approve(address(cc), paid);
        vm.stopPrank();

        uint256 fee = cc.feeFor(0);
        vm.deal(alice, fee);
        vm.expectRevert(abi.encodeWithSelector(CraftingController.FreeTokenLocked.selector, freeId));
        vm.prank(alice);
        cc.commit{value: fee}(freeId, paid, keccak256(abi.encode(_seq(2, 0), SALT)), 0);
    }

    function test_Commit_FreeTokenAllowedAfterWave5() public {
        PowMintNFTv3_1 c = _deployCore(BASE_BITS, 2, FREE_CLAIMS, 40);
        CraftingController cc = new CraftingController(address(c));
        c.setModule(address(cc), true);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("free1")));
        c.addCodes(hs);
        vm.prank(alice);
        c.claim(bytes32("free1"));
        uint256 freeId = c.totalMinted();

        // reach wave 5: epochSize=2 → epoch 4 needs 8 paid mints.
        for (uint256 i; i < 8; ++i) {
            _mintTo(c, address(uint160(0x5000 + i)));
        }
        assertGe(c.currentWave(), c.LOCK_WAVES(), "unlocked");

        uint256 paid = _mintTo(c, alice);
        vm.startPrank(alice);
        c.approve(address(cc), freeId);
        c.approve(address(cc), paid);
        vm.stopPrank();

        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 fee = cc.feeFor(0);
        vm.deal(alice, fee);
        vm.prank(alice);
        cc.commit{value: fee}(freeId, paid, keccak256(abi.encode(ch, SALT)), 0);
        assertEq(c.ownerOf(freeId), address(cc), "free card escrowed after wave 5");
    }

    // ============================================================= pause

    function test_Paused_BlocksCommitAndReveal_NotRefund() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        uint256 cb = _commitBlockOf(ctrl, id);

        ctrl.setPaused(true);

        // commit blocked
        (uint256 a2, uint256 b2) = _prepareTwo(core, ctrl, alice);
        uint256 fee = ctrl.feeFor(0);
        vm.deal(alice, fee);
        vm.expectRevert(CraftingController.Paused.selector);
        vm.prank(alice);
        ctrl.commit{value: fee}(a2, b2, keccak256(abi.encode(ch, SALT)), 0);

        // reveal blocked
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);
        vm.expectRevert(CraftingController.Paused.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, SALT);

        // refund never blocked
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id);
        assertEq(core.ownerOf(a), alice, "refund works while paused");
    }

    // ============================================================= admin

    function test_WithdrawFees_OnlyOwner_ToTreasury() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        uint256 id = _commit(ctrl, alice, a, b, _seq(2, 0), 1);
        uint256 fee = ctrl.feeFor(1);
        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 259);
        vm.prank(alice);
        ctrl.refund(id); // fees stay in the controller

        assertEq(address(ctrl).balance, fee);

        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.withdrawFees();

        uint256 tBefore = treasury.balance;
        ctrl.withdrawFees();
        assertEq(treasury.balance, tBefore + fee, "fees at treasury");
        assertEq(address(ctrl).balance, 0, "controller drained");
    }

    function test_Ownership_TwoStep() public {
        vm.expectRevert(CraftingController.ZeroAddress.selector);
        ctrl.transferOwnership(address(0));

        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.transferOwnership(bob);

        ctrl.transferOwnership(nominee);
        assertEq(ctrl.owner(), address(this), "not yet");
        assertEq(ctrl.pendingOwner(), nominee);

        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.acceptOwnership();

        vm.prank(nominee);
        ctrl.acceptOwnership();
        assertEq(ctrl.owner(), nominee);
        assertEq(ctrl.pendingOwner(), address(0));
    }

    function test_Constructor_ZeroNft_Reverts() public {
        vm.expectRevert(CraftingController.ZeroAddress.selector);
        new CraftingController(address(0));
    }

    function test_SetPaused_OnlyOwner() public {
        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.setPaused(true);
        ctrl.setPaused(true);
        assertTrue(ctrl.paused());
    }

    // ============================================================= quota / series

    function test_Quota_InvariantAfterSeries() public {
        for (uint256 k; k < 3; ++k) {
            (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
            CraftingController.SlotChoice[] memory ch = _seq(2, 0);
            uint256 id = _commit(ctrl, alice, a, b, ch, 0);
            _revealOk(ctrl, id, ch);
        }

        assertEq(core.totalBurned(), 6, "3 crafts x 2 burns");
        assertEq(core.totalForged(), 3, "3 crafts x 1 forge");
        assertLe(core.totalForged(), core.totalBurned(), "quota holds");
        for (uint256 i; i < 3; ++i) {
            assertEq(core.ownerOf(core.FORGE_ID_BASE() + i), alice);
        }
    }

    // ============================================================= v1.1 burn points

    function test_Reveal_NoRegistry_AccruesBasePoints() public {
        MockBurnPoints bp = new MockBurnPoints();
        ctrl.setPoints(address(bp));

        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        _revealOk(ctrl, id, ch);

        assertEq(bp.points(alice), 20, "10 + 10 (both standard)");
        assertEq(bp.calls(), 1, "one accrue call");
    }

    function test_Reveal_WithRegistry_AccruesByRarity() public {
        MockBurnPoints bp = new MockBurnPoints();
        CraftMockRegistry reg = new CraftMockRegistry();
        ctrl.setPoints(address(bp));
        ctrl.setRegistry(address(reg));

        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        reg.setBps(bytes32(a), 16000); // Rare 1.6× → 16
        reg.setBps(bytes32(b), 30000); // Mythic 3.0× → 30

        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        _revealOk(ctrl, id, ch);

        assertEq(bp.points(alice), 46, "16 + 30");
        assertEq(bp.calls(), 1, "one accrue call");
    }

    function test_Reveal_PointsZero_NoAccrual_NoRevert() public {
        // points == 0 → reveal still succeeds with no accrual.
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        _revealOk(ctrl, id, ch);
        assertEq(core.ownerOf(core.FORGE_ID_BASE()), alice, "reveal ok");
    }

    function test_Reveal_QuotaCountersUnchanged_WithPoints() public {
        MockBurnPoints bp = new MockBurnPoints();
        ctrl.setPoints(address(bp));

        uint256 burned0 = core.totalBurned();
        uint256 forged0 = core.totalForged();
        for (uint256 k; k < 3; ++k) {
            (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
            CraftingController.SlotChoice[] memory ch = _seq(2, 0);
            uint256 id = _commit(ctrl, alice, a, b, ch, 0);
            _revealOk(ctrl, id, ch);
        }

        assertEq(core.totalBurned(), burned0 + 6, "6 burns");
        assertEq(core.totalForged(), forged0 + 3, "3 forges");
        assertLe(core.totalForged(), core.totalBurned(), "quota holds");
        assertEq(bp.points(alice), 60, "3 x 20 points");
        assertEq(bp.calls(), 3, "3 accruals");
    }

    function test_SetRegistry_OnlyOwner_Event() public {
        CraftMockRegistry reg = new CraftMockRegistry();

        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.setRegistry(address(reg));

        vm.expectEmit(true, false, false, true, address(ctrl));
        emit CraftingController.RegistrySet(address(reg));
        ctrl.setRegistry(address(reg));
        assertEq(ctrl.registry(), address(reg), "registry set");

        ctrl.setRegistry(address(0));
        assertEq(ctrl.registry(), address(0), "registry cleared");
    }

    function test_SetPoints_OnlyOwner_Event() public {
        MockBurnPoints bp = new MockBurnPoints();

        vm.expectRevert(CraftingController.NotOwnerRole.selector);
        vm.prank(alice);
        ctrl.setPoints(address(bp));

        vm.expectEmit(true, false, false, true, address(ctrl));
        emit CraftingController.PointsSet(address(bp));
        ctrl.setPoints(address(bp));
        assertEq(ctrl.points(), address(bp), "points set");

        ctrl.setPoints(address(0));
        assertEq(ctrl.points(), address(0), "points cleared");
    }

    // ============================================================= W3 regression
    // W3-01 (salt binds the preimage → commit is no longer brute-forceable) and
    // W3-02 (open-commit fees stay reserved so refunds keep working under forgePaused).

    /// W3-01: a reveal with the wrong salt can never match the committed preimage.
    function test_Reveal_WrongSalt_Reverts_HashMismatch() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0); // committed with SALT

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);

        vm.expectRevert(CraftingController.HashMismatch.selector);
        vm.prank(alice);
        ctrl.reveal(id, ch, WRONG_SALT);
    }

    /// W3-01 attack scenario: even knowing the exact valid choices, a third party cannot
    /// force-settle the commit without the committer's secret salt (so the refund option,
    /// which RT-1 monetizes, stays with the committer). A valid salt settles; a different
    /// salt then reverts (Here: the commit is already settled).
    function test_Reveal_BruteForceWithoutSalt_CannotForceSettle() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        // tier0 cap = 6; an attacker enumerates the whole valid space and lands on `ch`.
        CraftingController.SlotChoice[] memory ch = _seq(6, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);

        uint256 cb = _commitBlockOf(ctrl, id);
        vm.roll(cb + 3);
        vm.setBlockhash(cb + 2, ENTROPY);

        // guessed / zero salt → HashMismatch; the commit stays OPEN (attack fails).
        vm.expectRevert(CraftingController.HashMismatch.selector);
        vm.prank(carol);
        ctrl.reveal(id, ch, bytes32(0));
        vm.expectRevert(CraftingController.HashMismatch.selector);
        vm.prank(carol);
        ctrl.reveal(id, ch, WRONG_SALT);

        (,,,,,,,, bool revealed,) = ctrl.commits(id);
        assertFalse(revealed, "commit not force-settled");

        // the valid salt works (a permissionless relayer may settle; child still → alice).
        vm.prank(carol);
        ctrl.reveal(id, ch, SALT);
        assertEq(core.ownerOf(core.FORGE_ID_BASE()), alice, "child goes to committer");
        assertEq(core.balanceOf(carol), 0, "revealer gets nothing");

        // a different salt after settlement is impossible (AlreadySettled).
        vm.expectRevert(CraftingController.AlreadySettled.selector);
        vm.prank(carol);
        ctrl.reveal(id, ch, WRONG_SALT);
    }

    /// W3-02: `withdrawFees()` must never touch fees reserved for open commits.
    function test_WithdrawFees_SkipsReservedCommitFees() public {
        uint256 fee = ctrl.feeFor(0);

        // a settled (withdrawable) fee: commit → refund (no forgePaused) keeps the fee.
        (uint256 a1, uint256 b1) = _prepareTwo(core, ctrl, alice);
        uint256 id1 = _commit(ctrl, alice, a1, b1, _seq(2, 0), 0);
        vm.roll(_commitBlockOf(ctrl, id1) + 259);
        vm.prank(alice);
        ctrl.refund(id1);
        assertEq(ctrl.committedFees(), 0, "reservation released on refund");
        assertEq(address(ctrl).balance, fee, "settled fee held");

        // an open commit → its fee becomes reserved.
        (uint256 a2, uint256 b2) = _prepareTwo(core, ctrl, alice);
        uint256 id2 = _commit(ctrl, alice, a2, b2, _seq(2, 0), 0);
        assertEq(ctrl.committedFees(), fee, "open-commit fee reserved");
        assertEq(address(ctrl).balance, 2 * fee, "settled + reserved");

        // sweep only the settled part; the reserved fee stays put.
        uint256 tBefore = treasury.balance;
        ctrl.withdrawFees();
        assertEq(treasury.balance, tBefore + fee, "only the settled fee is withdrawn");
        assertEq(address(ctrl).balance, fee, "reserved fee untouched");
        assertEq(ctrl.committedFees(), fee, "reservation intact");

        // nothing settled remains → NothingToWithdraw.
        vm.expectRevert(CraftingController.NothingToWithdraw.selector);
        ctrl.withdrawFees();

        // the reserved fee is still refundable later (window elapsed, no forgePaused → cards only).
        vm.roll(_commitBlockOf(ctrl, id2) + 259);
        vm.prank(alice);
        ctrl.refund(id2);
        assertEq(ctrl.committedFees(), 0, "reservation released");
        assertEq(address(ctrl).balance, fee, "the (now settled) fee remains");
    }

    /// W3-02 / RT-5: a `withdrawFees()` sweep before the window must not strand a refund
    /// that later needs the full fee back under `forgePaused`.
    function test_Refund_FullFeeAfterWithdrawFees_WhenForgePaused() public {
        uint256 fee = ctrl.feeFor(0);

        // settled fee S = fee.
        (uint256 a1, uint256 b1) = _prepareTwo(core, ctrl, alice);
        uint256 id1 = _commit(ctrl, alice, a1, b1, _seq(2, 0), 0);
        vm.roll(_commitBlockOf(ctrl, id1) + 259);
        vm.prank(alice);
        ctrl.refund(id1);

        // open a 2nd commit → fee reserved.
        (uint256 a2, uint256 b2) = _prepareTwo(core, ctrl, alice);
        uint256 id2 = _commit(ctrl, alice, a2, b2, _seq(2, 0), 0);

        // protocol fault: forge paused. Sweep must only take the settled fee.
        core.setForgePaused(true);
        uint256 tBefore = treasury.balance;
        ctrl.withdrawFees();
        assertEq(treasury.balance, tBefore + fee, "settled fee swept");
        assertEq(address(ctrl).balance, fee, "reserved fee kept for the pending refund");

        // after the window the committer gets the FULL fee back (RT-5) despite the sweep.
        vm.roll(_commitBlockOf(ctrl, id2) + 259);
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        ctrl.refund(id2);
        assertEq(alice.balance, balBefore + fee, "full fee refunded under forgePaused");
        assertEq(address(ctrl).balance, 0, "controller drained by the refund");
    }

    /// W3-02: `reveal` releases the reservation, after which the fee is withdrawable.
    function test_Reveal_ReleasesReservation_ThenWithdrawSweeps() public {
        (uint256 a, uint256 b) = _prepareTwo(core, ctrl, alice);
        CraftingController.SlotChoice[] memory ch = _seq(2, 0);
        uint256 id = _commit(ctrl, alice, a, b, ch, 0);
        uint256 fee = ctrl.feeFor(0);

        // while the commit is open, its fee is reserved → nothing to withdraw.
        vm.expectRevert(CraftingController.NothingToWithdraw.selector);
        ctrl.withdrawFees();

        _revealOk(ctrl, id, ch);
        assertEq(ctrl.committedFees(), 0, "reservation released on reveal");

        uint256 tBefore = treasury.balance;
        ctrl.withdrawFees();
        assertEq(treasury.balance, tBefore + fee, "earned fee swept after reveal");
        assertEq(address(ctrl).balance, 0, "controller drained");
    }
}
