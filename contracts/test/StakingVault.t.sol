// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {PowMintNFTv3_1} from "../src/PowMintNFTv3_1.sol";
import {ERC721Minimal} from "../src/ERC721Minimal.sol";
import {RarityRegistry} from "../src/RarityRegistry.sol";

/// @dev Minimal ERC-721 with a no-op staking-discount hook: exercises the vault's happy
///      paths without the cost of grinding real PoW. Mirrors the core's interface subset.
contract MockNFT is ERC721Minimal {
    uint256 private _next = 1;
    mapping(address => uint8) public stakingDiscountBits;

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }

    function setStakingDiscount(address wallet, uint8 bits) external {
        require(bits <= 6, "bits>6");
        stakingDiscountBits[wallet] = bits;
    }
}

/// @dev A plain ERC-721 that is NOT a House Card: used to prove the vault rejects a
///      "foreign" token through the immutable core address / missing module hook.
contract ForeignNFT is ERC721Minimal {
    uint256 private _next = 1;

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }
}

/// @dev v1.1 test double for RarityRegistry's `bpsOf` (economy v1.1 spec §1): per-key bps,
///      defaulting to 10000 (1.0×) when unset. Lets vault tests avoid depending on the
///      parallel agent's real RarityRegistry while exercising the exact same interface.
contract MockRarityRegistry {
    mapping(bytes32 => uint16) private _bps;

    function setBps(bytes32 cardKey, uint16 bps) external {
        _bps[cardKey] = bps;
    }

    function bpsOf(bytes32 cardKey) external view returns (uint16) {
        uint16 v = _bps[cardKey];
        return v == 0 ? 10000 : v;
    }
}

/// @dev v1.1 test double for StakeRewards' `setWeight` (economy v1.1 spec §3): records the
///      pushed weight per wallet and the number of calls, so tests can assert pushes.
contract MockStakeRewards {
    mapping(address => uint256) public weight;
    mapping(address => uint256) public callsFor;
    uint256 public calls;

    function setWeight(address wallet, uint256 newWeight) external {
        weight[wallet] = newWeight;
        callsFor[wallet] += 1;
        calls += 1;
    }
}

/// @title StakingVaultTest — unit + integration suite for StakingVault v1 (`staking spec`).
contract StakingVaultTest is Test {
    StakingVault vault;
    MockNFT mock;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address treasury = address(0xFEE);

    string constant BASE = "https://t/x/api/";

    // ------------------------------------------------ real-core integration params
    uint8 constant IBASE = 6;
    uint256 constant IPRICE = 1e15;
    uint256 constant IEPOCH = 2;
    uint256 constant IREG = 3;
    uint256 constant IPACE = 60;

    function setUp() public {
        mock = new MockNFT();
        vault = new StakingVault(address(mock));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------- helpers

    function _expectedBits(uint8 tier) internal pure returns (uint8) {
        if (tier <= 1) return 2;
        if (tier <= 3) return 4;
        return 6;
    }

    function _expectedWeight(uint8 tier) internal pure returns (uint8) {
        uint8[6] memory w = [uint8(1), 5, 10, 20, 30, 40];
        return w[tier];
    }

    function _approveAndStake(address who, uint256 id, uint8 tier) internal {
        vm.startPrank(who);
        mock.approve(address(vault), id);
        vault.stake(id, tier);
        vm.stopPrank();
    }

    /// @dev Full stake/unstake round trip for one tier (weights, stakedAt, discount).
    function _tierHappy(uint8 tier) internal {
        uint256 id = mock.mint(alice);
        uint256 t0 = block.timestamp;

        _approveAndStake(alice, id, tier);

        (address o, uint8 t, uint64 sa, uint64 ac, uint64 la) = vault.stakeInfo(id);
        assertEq(o, alice, "owner");
        assertEq(uint256(t), tier, "tier");
        assertEq(uint256(sa), t0, "stakedAt");
        assertEq(uint256(ac), 0, "accrued starts 0");
        assertEq(uint256(la), t0, "lastAccrual");

        assertEq(uint256(vault.bitsForTier(tier)), _expectedBits(tier), "bits table");
        assertEq(uint256(vault.weightX10(tier)), _expectedWeight(tier), "weight table");
        assertEq(uint256(mock.stakingDiscountBits(alice)), _expectedBits(tier), "discount set");
        assertEq(vault.stakeCount(), 1, "count");
        assertEq(vault.stakesOf(alice).length, 1, "list");

        // accrual over a 1000s window = 1000 · weight×10
        vm.warp(t0 + 1000);
        assertEq(uint256(vault.accruedOf(id)), 1000 * uint256(_expectedWeight(tier)), "accrual");

        // pass the hard lock, then unstake cleanly (tier0 has a zero-length lock).
        vm.warp(t0 + (uint256(vault.lockDays(tier)) + 1) * 1 days);
        vm.prank(alice);
        vault.unstake(id);

        assertEq(mock.ownerOf(id), alice, "nft returned");
        assertEq(uint256(mock.stakingDiscountBits(alice)), 0, "discount cleared");
        assertEq(vault.stakeCount(), 0, "count cleared");
        assertEq(vault.stakesOf(alice).length, 0, "list cleared");
        assertEq(uint256(vault.accruedOf(id)), 0, "no record");
    }

    // ============================================== tier happy paths (6)

    function test_Tier0_StakeUnstake() public {
        _tierHappy(0);
    }

    function test_Tier1_StakeUnstake() public {
        _tierHappy(1);
    }

    function test_Tier2_StakeUnstake() public {
        _tierHappy(2);
    }

    function test_Tier3_StakeUnstake() public {
        _tierHappy(3);
    }

    function test_Tier4_StakeUnstake() public {
        _tierHappy(4);
    }

    function test_Tier5_StakeUnstake() public {
        _tierHappy(5);
    }

    // ============================================== events / aggregation

    function test_Stake_EmitsStaked() public {
        uint256 id = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakingVault.Staked(id, alice, 2, 4);
        vault.stake(id, 2);
        vm.stopPrank();
    }

    function test_MaxAggregation_AndBoostEvents() public {
        uint256 idA = mock.mint(alice);
        uint256 idB = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), idA);
        mock.approve(address(vault), idB);

        // tier0 → 2 bits
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.BoostSet(alice, 2);
        vault.stake(idA, 0);

        // tier4 → max(2,6) = 6
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.BoostSet(alice, 6);
        vault.stake(idB, 4);
        vm.stopPrank();

        assertEq(uint256(mock.stakingDiscountBits(alice)), 6, "aggregate 6");

        // hard lock: tier4 (180d) must be past its term before it can be withdrawn.
        vm.warp(block.timestamp + (uint256(vault.lockDays(4)) + 1) * 1 days);

        // unstake tier4 → back to 2
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.BoostSet(alice, 2);
        vm.prank(alice);
        vault.unstake(idB);
        assertEq(uint256(mock.stakingDiscountBits(alice)), 2, "back to 2");

        // unstake last (tier0 → flexible) → 0
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.BoostSet(alice, 0);
        vm.prank(alice);
        vault.unstake(idA);
        assertEq(uint256(mock.stakingDiscountBits(alice)), 0, "cleared");
    }

    // ============================================== guards

    function test_Stake_DoubleReverts() public {
        uint256 id = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id);
        vault.stake(id, 1);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.AlreadyStaked.selector, id));
        vault.stake(id, 2);
        vm.stopPrank();
    }

    function test_Unstake_NonStakerReverts() public {
        uint256 id = mock.mint(alice);
        // tier0 (flexible) so the hard-lock check passes and the owner guard is reached.
        _approveAndStake(alice, id, 0);

        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotStakeOwner.selector, id));
        vm.prank(bob);
        vault.unstake(id);
    }

    function test_Unstake_NotStakedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotStaked.selector, 999));
        vm.prank(alice);
        vault.unstake(999);
    }

    function test_Stake_WithoutApproveReverts() public {
        uint256 id = mock.mint(alice);
        // vault is not approved → core ERC-721 transferFrom reverts
        vm.expectRevert(ERC721Minimal.NotAuthorized.selector);
        vm.prank(alice);
        vault.stake(id, 1);
    }

    function test_Stake_BadTierReverts() public {
        uint256 id = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.BadTier.selector, uint8(6)));
        vault.stake(id, 6);
        vm.stopPrank();
    }

    function test_Paused_BlocksStakeNotUnstake() public {
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 1);

        vault.setPaused(true);
        assertTrue(vault.paused());

        // second stake blocked while paused
        uint256 id2 = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id2);
        vm.expectRevert(StakingVault.Paused.selector);
        vault.stake(id2, 0);
        vm.stopPrank();

        // hard lock: tier1 (7d) must elapse before the exit is allowed — but `paused` never
        // blocks `unstake` (we prove that once the term is over while still paused).
        vm.warp(block.timestamp + (uint256(vault.lockDays(1)) + 1) * 1 days);
        vm.prank(alice);
        vault.unstake(id);
        assertEq(mock.ownerOf(id), alice, "unstake not blocked");
    }

    // ============================================== owner / 2-step

    function test_Admin_OnlyOwner() public {
        vm.expectRevert(StakingVault.NotOwnerRole.selector);
        vm.prank(alice);
        vault.setPaused(true);

        vm.expectRevert(StakingVault.NotOwnerRole.selector);
        vm.prank(alice);
        vault.transferOwnership(bob);
    }

    function test_Ownership_TwoStep() public {
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        vault.transferOwnership(address(0));

        vault.transferOwnership(carol);
        assertEq(vault.owner(), address(this), "not yet");
        assertEq(vault.pendingOwner(), carol, "nominated");

        // stranger cannot accept
        vm.expectRevert(StakingVault.NotOwnerRole.selector);
        vm.prank(alice);
        vault.acceptOwnership();

        vm.prank(carol);
        vault.acceptOwnership();
        assertEq(vault.owner(), carol, "accepted");
        assertEq(vault.pendingOwner(), address(0), "cleared");
    }

    function test_Constructor_ZeroNftReverts() public {
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(address(0));
    }

    // ============================================== foreign token

    function test_Stake_ForeignTokenRevertsViaCore() public {
        ForeignNFT foreign = new ForeignNFT();
        PowMintNFTv3_1 core = _deployCore(IBASE, IEPOCH, 1, 40);
        StakingVault v = new StakingVault(address(core));
        core.setModule(address(v), true);

        uint256 fid = foreign.mint(alice);
        vm.startPrank(alice);
        foreign.approve(address(v), fid);
        // core has no such token owned by alice → core.transferFrom reverts WrongFrom
        vm.expectRevert(ERC721Minimal.WrongFrom.selector);
        v.stake(fid, 1);
        vm.stopPrank();
    }

    function test_Stake_VaultOnNonCoreReverts() public {
        ForeignNFT foreign = new ForeignNFT();
        StakingVault v = new StakingVault(address(foreign));

        uint256 fid = foreign.mint(alice);
        vm.startPrank(alice);
        foreign.approve(address(v), fid);
        // foreign NFT has no setStakingDiscount → the discount push reverts
        vm.expectRevert();
        v.stake(fid, 1);
        vm.stopPrank();
    }

    // ============================================== hard lock (owner decision 18.09.2026)

    // (a) tier0 is flexible (lockDays == 0 → lockEnd == stakedAt) → immediate exit works.
    function test_Tier0_UnstakeImmediately() public {
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 0);

        vm.prank(alice);
        vault.unstake(id);

        assertEq(mock.ownerOf(id), alice, "flexible card returned immediately");
        assertEq(uint256(mock.stakingDiscountBits(alice)), 0, "discount cleared");
        assertEq(vault.stakeCount(), 0, "count cleared");
    }

    // (b) tier1 before lockEnd reverts Locked, and the revert exposes `until` (= stakedAt + 7d).
    function test_Tier1_UnstakeBeforeLockEnd_RevertsLocked() public {
        uint256 id = mock.mint(alice);
        uint256 t0 = block.timestamp;
        _approveAndStake(alice, id, 1); // 7d lock

        uint64 lockEnd = uint64(t0 + 7 days);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.Locked.selector, lockEnd));
        vm.prank(alice);
        vault.unstake(id);

        assertEq(mock.ownerOf(id), address(vault), "card still held by the vault");
        assertEq(vault.stakeCount(), 1, "stake still active");
    }

    // (c) at/after lockEnd the exit succeeds (warp straight to the term end).
    function test_Unstake_AtLockEnd_Succeeds() public {
        uint256 id = mock.mint(alice);
        uint256 t0 = block.timestamp;
        _approveAndStake(alice, id, 2); // 30d lock

        vm.warp(t0 + 30 days); // exactly lockEnd
        vm.prank(alice);
        vault.unstake(id);

        assertEq(mock.ownerOf(id), alice, "returned exactly at lockEnd");
        assertEq(vault.stakeCount(), 0, "count cleared");
    }

    // (d) boundary: lockEnd == stakedAt + lockDays(tier)·1 days. One second before → Locked;
    //     exactly at the second → success (strict `<` comparison).
    function test_LockEnd_Boundary_OneSecondBeforeReverts_AtSecondSucceeds() public {
        uint256 id = mock.mint(alice);
        uint256 t0 = block.timestamp;
        _approveAndStake(alice, id, 3); // 90d lock

        uint256 lockEnd = t0 + uint256(vault.lockDays(3)) * 1 days;
        assertEq(lockEnd - t0, 90 * 1 days, "lockEnd = stakedAt + lockDays(tier) days");

        vm.warp(lockEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.Locked.selector, uint64(lockEnd)));
        vm.prank(alice);
        vault.unstake(id);
        assertEq(mock.ownerOf(id), address(vault), "one second early, still locked");

        vm.warp(lockEnd);
        vm.prank(alice);
        vault.unstake(id);
        assertEq(mock.ownerOf(id), alice, "exactly at lockEnd, success");
    }

    // (e) a locked card blocks nothing else: other wallets and other cards stake/unstake freely.
    function test_LockedCard_DoesNotBlockOtherStakes() public {
        uint256 locked = mock.mint(alice);
        uint256 flexible = mock.mint(bob);
        _approveAndStake(alice, locked, 5); // 365d hard lock

        // bob stakes and immediately exits a flexible card — alice's lock is irrelevant.
        _approveAndStake(bob, flexible, 0);
        vm.prank(bob);
        vault.unstake(flexible);
        assertEq(mock.ownerOf(flexible), bob, "independent stake unaffected");

        // alice may still stake a second card while the first is locked.
        uint256 extra = mock.mint(alice);
        _approveAndStake(alice, extra, 0);
        assertEq(vault.stakeCount(), 2, "second stake allowed while one is locked");

        vm.prank(alice);
        vault.unstake(extra);
        assertEq(mock.ownerOf(extra), alice, "flexible extra card returned");
        assertEq(mock.ownerOf(locked), address(vault), "locked card still held");
    }

    // (f) Unstaked carries exactly two args (tokenId, owner) — the `penalized` flag is gone.
    function test_Unstake_EmitsUnstaked_TwoArgs() public {
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 0);

        vm.expectEmit(true, true, false, false, address(vault));
        emit StakingVault.Unstaked(id, alice);
        vm.prank(alice);
        vault.unstake(id);
    }

    // ============================================== _stakesOf swap-pop

    function test_StakesOf_SwapPop() public {
        uint256 id1 = mock.mint(alice);
        uint256 id2 = mock.mint(alice);
        uint256 id3 = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id1);
        mock.approve(address(vault), id2);
        mock.approve(address(vault), id3);
        vault.stake(id1, 0);
        vault.stake(id2, 2);
        vault.stake(id3, 0);
        vm.stopPrank();

        assertEq(vault.stakeCount(), 3);
        uint256[] memory all = vault.stakesOf(alice);
        assertEq(all.length, 3);
        assertEq(all[0], id1);
        assertEq(all[1], id2);
        assertEq(all[2], id3);

        // remove the middle element (tier2, 30d hard lock → warp past its term) → the last
        // element (tier0 id3) swaps into its slot
        vm.warp(block.timestamp + (uint256(vault.lockDays(2)) + 1) * 1 days);
        vm.prank(alice);
        vault.unstake(id2);

        uint256[] memory rest = vault.stakesOf(alice);
        assertEq(rest.length, 2, "length after pop");
        assertEq(rest[0], id1, "index 0 untouched");
        assertEq(rest[1], id3, "last swapped into removed slot");
        assertEq(vault.stakeCount(), 2);

        // the moved element can still be removed correctly (index bookkeeping intact)
        vm.prank(alice);
        vault.unstake(id3);
        uint256[] memory one = vault.stakesOf(alice);
        assertEq(one.length, 1);
        assertEq(one[0], id1);
    }

    function test_AccruedOf_NonStakedZero() public view {
        assertEq(uint256(vault.accruedOf(123)), 0);
    }

    // ============================================== integration (real core)

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
            IPRICE,
            epochSize_,
            freeClaims_,
            maxSupply_,
            500,
            0,
            IREG,
            IPACE
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

    /// @dev Grind-mint on the real core with a slow pace (warp +400s keeps the load
    ///      regulator at 0 and lets streaks expire), optionally forwarding the token.
    function _mintCore(PowMintNFTv3_1 n, address miner, address to) internal returns (uint256 id) {
        vm.warp(block.timestamp + 400);
        uint8 bits = n.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(n), miner, bits, _nonceCursor[miner]);
        _nonceCursor[miner] = nonce + 1;
        uint256 price = n.currentPrice();
        vm.deal(miner, price);
        vm.prank(miner);
        n.mint{value: price}(nonce);
        id = n.totalMinted();
        if (to != miner) {
            vm.prank(miner);
            n.transferFrom(miner, to, id);
        }
    }

    function test_Integration_StakeRevertsBeforeModuleSet() public {
        PowMintNFTv3_1 core = _deployCore(IBASE, IEPOCH, 2, 40);
        StakingVault v = new StakingVault(address(core));

        uint256 id = _mintCore(core, address(0xB1), alice);

        vm.startPrank(alice);
        core.approve(address(v), id);
        // vault is not a core module → setStakingDiscount reverts NotModule (whole tx rolls back)
        vm.expectRevert(PowMintNFTv3_1.NotModule.selector);
        v.stake(id, 2);
        vm.stopPrank();

        assertEq(core.ownerOf(id), alice, "stake rolled back");
    }

    function test_Integration_DiscountAndRequiredBits() public {
        PowMintNFTv3_1 core = _deployCore(IBASE, IEPOCH, 2, 40);
        StakingVault v = new StakingVault(address(core));
        core.setModule(address(v), true);

        // 6 paid mints → epochIndex 3 → alice (no streak) difficulty = base + 2·3 = 12
        uint256 id0 = _mintCore(core, address(0xB1), alice);
        _mintCore(core, address(0xB2), address(0xB2));
        _mintCore(core, address(0xB3), address(0xB3));
        _mintCore(core, address(0xB4), address(0xB4));
        _mintCore(core, address(0xB5), address(0xB5));
        uint256 id1 = _mintCore(core, address(0xB6), alice);

        assertEq(core.epochIndex(), 3, "epoch");
        assertEq(core.requiredBits(alice), IBASE + 6, "base difficulty 12");

        vm.startPrank(alice);
        core.approve(address(v), id0);
        core.approve(address(v), id1);

        // tier2 (4 bits) → 12 − 4 = 8
        v.stake(id0, 2);
        assertEq(uint256(core.stakingDiscountBits(alice)), 4, "discount 4");
        assertEq(core.requiredBits(alice), 8, "difficulty 8");

        // tier4 (6 bits) → 12 − 6 = 6 (floor = baseBits)
        v.stake(id1, 4);
        assertEq(uint256(core.stakingDiscountBits(alice)), 6, "discount 6");
        assertEq(core.requiredBits(alice), IBASE, "difficulty floored at baseBits");

        // unstake tier4 → discount 4 again (past the hard lock: tier4 = 180d)
        vm.warp(block.timestamp + (uint256(v.lockDays(4)) + 1) * 1 days);
        v.unstake(id1);
        assertEq(uint256(core.stakingDiscountBits(alice)), 4, "back to 4");
        assertEq(core.requiredBits(alice), 8, "difficulty 8 again");

        // unstake tier2 → discount 0, full difficulty
        v.unstake(id0);
        assertEq(uint256(core.stakingDiscountBits(alice)), 0, "cleared");
        assertEq(core.requiredBits(alice), IBASE + 6, "full difficulty");
        vm.stopPrank();

        assertEq(core.ownerOf(id0), alice);
        assertEq(core.ownerOf(id1), alice);
    }

    function test_Integration_FreeTokenLocked() public {
        PowMintNFTv3_1 core = _deployCore(IBASE, IEPOCH, 2, 40);
        StakingVault v = new StakingVault(address(core));
        core.setModule(address(v), true);

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = keccak256(abi.encodePacked(bytes32("free1")));
        core.addCodes(hs);

        vm.prank(alice);
        core.claim(bytes32("free1"));
        uint256 id = core.totalMinted();
        assertTrue(core.isFreeToken(id), "free token");
        assertLt(core.currentWave(), core.LOCK_WAVES(), "still locked");

        vm.startPrank(alice);
        core.approve(address(v), id);
        // the core's free-token lock blocks the transfer into the vault by design
        vm.expectRevert(abi.encodeWithSelector(PowMintNFTv3_1.FreeTokenLocked.selector, id));
        v.stake(id, 0);
        vm.stopPrank();
    }

    // ============================================== v1.1 weightOf (rarity-aware)

    function test_WeightOf_NoRegistry_PerTier() public {
        for (uint8 tier; tier < 6; ++tier) {
            uint256 id = mock.mint(alice);
            _approveAndStake(alice, id, tier);
            assertEq(
                vault.weightOf(alice), uint256(_expectedWeight(tier)), "weight == weightX10 (no registry)"
            );
            // pass the lock so the exit starts no cooldown (the loop re-stakes from alice).
            vm.warp(block.timestamp + (uint256(vault.lockDays(tier)) + 1) * 1 days);
            vm.prank(alice);
            vault.unstake(id);
            assertEq(vault.weightOf(alice), 0, "cleared after unstake");
        }
    }

    function test_WeightOf_WithRegistry_PerTier() public {
        MockRarityRegistry reg = new MockRarityRegistry();
        vault.setRegistry(address(reg));
        uint16[6] memory bps = [uint16(10000), 12000, 16000, 22000, 30000, 12000];
        for (uint8 tier; tier < 6; ++tier) {
            uint256 id = mock.mint(alice);
            reg.setBps(bytes32(id), bps[tier]);
            _approveAndStake(alice, id, tier);
            uint256 expected = (uint256(_expectedWeight(tier)) * bps[tier]) / 10000;
            assertEq(vault.weightOf(alice), expected, "weight == weightX10 x bps / 10000");
            // pass the lock so the exit starts no cooldown (the loop re-stakes from alice).
            vm.warp(block.timestamp + (uint256(vault.lockDays(tier)) + 1) * 1 days);
            vm.prank(alice);
            vault.unstake(id);
        }
    }

    function test_WeightOf_MultiStakes_Sums() public {
        MockRarityRegistry reg = new MockRarityRegistry();
        vault.setRegistry(address(reg));
        uint256 id1 = mock.mint(alice);
        uint256 id2 = mock.mint(alice);
        uint256 id3 = mock.mint(alice);
        reg.setBps(bytes32(id1), 16000); // tier2 w10 -> 16
        reg.setBps(bytes32(id2), 30000); // tier4 w30 -> 90
        // id3 defaults to 10000 -> tier0 w1 -> 1

        vm.startPrank(alice);
        mock.approve(address(vault), id1);
        mock.approve(address(vault), id2);
        mock.approve(address(vault), id3);
        vault.stake(id1, 2);
        vault.stake(id2, 4);
        vault.stake(id3, 0);
        vm.stopPrank();

        assertEq(vault.weightOf(alice), 16 + 90 + 1, "sum over stakes");
        assertEq(vault.weightOf(bob), 0, "unrelated wallet 0");
    }

    // ============================================== v1.1 pushes to StakeRewards

    function test_Stake_PushesWeightToRewards() public {
        MockStakeRewards rw = new MockStakeRewards();
        vault.setRewards(address(rw));

        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 2); // w10

        assertEq(rw.weight(alice), 10, "weight pushed on stake");
        assertEq(rw.callsFor(alice), 1, "exactly one push");
    }

    function test_Unstake_PushesWeightToRewards() public {
        MockStakeRewards rw = new MockStakeRewards();
        vault.setRewards(address(rw));

        uint256 id1 = mock.mint(alice);
        uint256 id2 = mock.mint(alice);
        vm.startPrank(alice);
        mock.approve(address(vault), id1);
        mock.approve(address(vault), id2);
        vault.stake(id1, 2); // 10
        vault.stake(id2, 4); // 30 -> 40
        vm.stopPrank();
        assertEq(rw.weight(alice), 40, "both staked");

        // hard lock: warp past both terms (tier4 = 180d is the longer) before any exit.
        vm.warp(block.timestamp + (uint256(vault.lockDays(4)) + 1) * 1 days);

        vm.prank(alice);
        vault.unstake(id1);
        assertEq(rw.weight(alice), 30, "weight re-pushed after unstake");

        vm.prank(alice);
        vault.unstake(id2);
        assertEq(rw.weight(alice), 0, "weight cleared");
        assertEq(rw.callsFor(alice), 4, "stake,stake,unstake,unstake");
    }

    function test_NoRewards_StakeUnstake_NoPushNoRevert() public {
        // defaults: rewards==0, registry==0 → no external push, plain weight.
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 3);
        assertEq(vault.weightOf(alice), 20, "plain weight");
        // hard lock: tier3 = 90d must elapse before the exit.
        vm.warp(block.timestamp + (uint256(vault.lockDays(3)) + 1) * 1 days);
        vm.prank(alice);
        vault.unstake(id);
        assertEq(vault.weightOf(alice), 0, "cleared");
    }

    function test_Poke_PushesCurrentWeight() public {
        MockStakeRewards rw = new MockStakeRewards();
        MockRarityRegistry reg = new MockRarityRegistry();
        vault.setRewards(address(rw));
        vault.setRegistry(address(reg));

        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 4); // w30, default bps → 30
        assertEq(rw.weight(alice), 30, "baseline push");

        // rarity attestation raises bps; anyone may poke, idempotent push of new weight.
        reg.setBps(bytes32(id), 30000); // 30 -> 90
        vm.prank(bob);
        vault.poke(alice);
        assertEq(rw.weight(alice), 90, "poke updates weight");
        assertEq(rw.callsFor(alice), 2, "second push");
    }

    function test_Poke_NoRewards_Noop() public {
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 1);
        vault.poke(alice); // rewards==0 → no-op, must not revert
        vault.poke(bob);
    }

    // ============================================== v1.1 pokeIfStaked (registry hook)

    function test_PokeIfStaked_RegistryAttest_RaisesWeight() public {
        MockStakeRewards rw = new MockStakeRewards();
        MockRarityRegistry reg = new MockRarityRegistry();
        vault.setRewards(address(rw));
        vault.setRegistry(address(reg));

        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 2); // w10, bps 10000 → 10
        assertEq(rw.weight(alice), 10, "baseline");
        assertEq(vault.weightOf(alice), 10);

        // simulate registry.attest → registry hook calls vault.pokeIfStaked(tokenKey)
        reg.setBps(bytes32(id), 22000); // Epic 2.2× → 10*22000/10000 = 22
        vm.prank(address(reg));
        vault.pokeIfStaked(bytes32(id));

        assertEq(rw.weight(alice), 22, "weight raised via hook");
        assertEq(rw.callsFor(alice), 2, "second push");
    }

    function test_PokeIfStaked_UnstakedKey_Noop() public {
        MockStakeRewards rw = new MockStakeRewards();
        vault.setRewards(address(rw));
        vault.pokeIfStaked(bytes32(uint256(12345))); // never staked
        assertEq(rw.calls(), 0, "no push for unstaked key");
    }

    function test_PokeIfStaked_NoRewards_Noop() public {
        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 0);
        vault.pokeIfStaked(bytes32(id)); // rewards==0 → no-op, no revert
    }

    // ============================================== v1.1 setters (owner-only)

    function test_SetRegistry_OnlyOwner_Event() public {
        MockRarityRegistry reg = new MockRarityRegistry();

        vm.expectRevert(StakingVault.NotOwnerRole.selector);
        vm.prank(alice);
        vault.setRegistry(address(reg));

        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.RegistrySet(address(reg));
        vault.setRegistry(address(reg));
        assertEq(vault.registry(), address(reg), "registry set");

        vault.setRegistry(address(0)); // clearing is allowed (disables rarity)
        assertEq(vault.registry(), address(0), "registry cleared");
    }

    function test_SetRewards_OnlyOwner_Event() public {
        MockStakeRewards rw = new MockStakeRewards();

        vm.expectRevert(StakingVault.NotOwnerRole.selector);
        vm.prank(alice);
        vault.setRewards(address(rw));

        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.RewardsSet(address(rw));
        vault.setRewards(address(rw));
        assertEq(vault.rewards(), address(rw), "rewards set");

        vault.setRewards(address(0));
        assertEq(vault.rewards(), address(0), "rewards cleared");
    }

    // ============================================== v1.1 integration (REAL RarityRegistry)

    function test_Integration_RealRarityRegistry_HookRaisesWeight() public {
        RarityRegistry reg = new RarityRegistry();
        MockStakeRewards rw = new MockStakeRewards();

        uint256 oraclePk = 0xA11CE0;
        address oracle = vm.addr(oraclePk);
        reg.setAttester(oracle);
        reg.setVault(address(vault));
        vault.setRegistry(address(reg));
        vault.setRewards(address(rw));

        uint256 id = mock.mint(alice);
        _approveAndStake(alice, id, 2); // tier2 w10, un-attested -> 10
        assertEq(rw.weight(alice), 10, "baseline weight");

        // oracle attests tier 4 (Mythic 3.0x) -> registry hook calls vault.pokeIfStaked
        bytes32 key = bytes32(id);
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = reg.hashAttestation(key, 4, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        reg.attest(key, 4, nonce, deadline, abi.encodePacked(r, s, v));

        assertEq(uint256(reg.bpsOf(key)), 30000, "bps 30000 (Mythic)");
        assertEq(vault.weightOf(alice), 30, "weightOf 10 x 30000 / 10000");
        assertEq(rw.weight(alice), 30, "weight raised via real registry hook");
    }

    // ============================================== v1.1: v1 invariants intact

    function test_V1Invariants_IntactWithWeights() public {
        MockStakeRewards rw = new MockStakeRewards();
        MockRarityRegistry reg = new MockRarityRegistry();
        vault.setRewards(address(rw));
        vault.setRegistry(address(reg));

        uint256 id = mock.mint(alice);
        reg.setBps(bytes32(id), 16000); // Rare 1.6×
        _approveAndStake(alice, id, 2); // w10 → 16

        assertEq(mock.ownerOf(id), address(vault), "custody intact");
        assertEq(uint256(mock.stakingDiscountBits(alice)), 4, "discount intact (tier2)");
        assertEq(rw.weight(alice), 16, "weight pushed");

        // hard lock: tier2 = 30d must elapse before the exit; exactly two event args.
        vm.warp(block.timestamp + (uint256(vault.lockDays(2)) + 1) * 1 days);
        vm.expectEmit(true, true, false, false, address(vault));
        emit StakingVault.Unstaked(id, alice);
        vm.prank(alice);
        vault.unstake(id);

        assertEq(mock.ownerOf(id), alice, "returned to staker");
        assertEq(uint256(mock.stakingDiscountBits(alice)), 0, "discount cleared");
        assertEq(rw.weight(alice), 0, "weight cleared on exit");
    }

    // ------------------------------------------------------------- misc
}
