// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakeRewards} from "../src/StakeRewards.sol";

/// @dev Reentrant claimer: on receiving funds it re-enters `claim` via a low-level call and
///      records whether the nested call was blocked (it must be) without reverting itself.
contract ReentrantClaimer {
    StakeRewards private immutable rewards;
    bool public blocked;
    bytes4 public innerError;
    bool private _reentered;

    constructor(StakeRewards rewards_) {
        rewards = rewards_;
    }

    function attack() external {
        rewards.claim();
    }

    receive() external payable {
        if (!_reentered) {
            _reentered = true;
            (bool ok, bytes memory data) =
                address(rewards).call(abi.encodeWithSelector(StakeRewards.claim.selector));
            blocked = !ok;
            if (data.length >= 4) {
                bytes4 sel;
                assembly {
                    sel := mload(add(data, 32))
                }
                innerError = sel;
            }
        }
    }
}

/// @title StakeRewardsTest — unit suite for StakeRewards v1.1 (`economy v1.1 spec` §3).
/// @dev NOTE: absolute timestamps are used for all `vm.warp` calls. Under `via_ir` the
///      optimizer rematerializes `block.timestamp`, so a captured base or `block.timestamp + N`
///      is NOT a stable snapshot across multiple warps in one test — absolute values are.
contract StakeRewardsTest is Test {
    StakeRewards rewards;

    address vault = address(0xBAD5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);

    function setUp() public {
        vm.warp(1_000_000);
        rewards = new StakeRewards();
        rewards.setVault(vault);
        vm.deal(address(this), 1000 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    // ------------------------------------------------------------- helpers

    function _setWeight(address who, uint256 w) internal {
        vm.prank(vault);
        rewards.setWeight(who, w);
    }

    // ===================================================== notify guards

    function test_Notify_OnlyOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(StakeRewards.NotOwnerRole.selector);
        rewards.notify{value: 1}(3600);
    }

    function test_Notify_ValueZero_Reverts() public {
        vm.expectRevert(StakeRewards.ZeroAmount.selector);
        rewards.notify{value: 0}(3600);
    }

    function test_Notify_DurationZero_Reverts() public {
        vm.expectRevert(StakeRewards.BadDuration.selector);
        rewards.notify{value: 1}(0);
    }

    function test_Notify_SetsRateAndPool() public {
        vm.expectEmit(false, false, false, true, address(rewards));
        emit StakeRewards.Notified(360_000, 3600, 100, 360_000);
        rewards.notify{value: 360_000}(3600);

        assertEq(rewards.ratePerSec(), 100, "rate = value/duration");
        assertEq(rewards.poolRemaining(), 360_000, "pool");
        assertEq(rewards.lastUpdate(), 1_000_000, "lastUpdate");
        assertEq(rewards.totalWeight(), 0, "no weight yet");
    }

    function test_Notify_MergesRate_Overlapping() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600); // rate 100, pool 360000
        assertEq(rewards.ratePerSec(), 100);

        vm.warp(1_001_800);
        rewards.notify{value: 180_000}(3600);

        // _accrue folded 180000; remaining time at old rate = 180000/100 = 1800s;
        // newRate = 360000 / (1800 + 3600) = 66 (integer).
        assertEq(rewards.ratePerSec(), 66, "merged rate");
        assertEq(rewards.poolRemaining(), 360_000, "merged pool");
    }

    // ===================================================== accrual + claim

    function test_Accrue_WithWeight_ClaimExact() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600); // rate 100

        vm.warp(1_001_000);
        assertEq(rewards.pendingOf(alice), 100_000, "pending = rate*dt");

        vm.prank(alice);
        rewards.claim();

        assertEq(alice.balance, 1 ether + 100_000, "exact transfer");
        assertEq(rewards.pendingOf(alice), 0, "reset");
        assertEq(rewards.poolRemaining(), 260_000, "pool drained by consumption");
    }

    function test_Claim_EmitsClaimed() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_001_000);

        vm.expectEmit(true, false, false, true, address(rewards));
        emit StakeRewards.Claimed(alice, 100_000);
        vm.prank(alice);
        rewards.claim();
    }

    function test_Claim_DoubleClaim_Zero() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_001_000);

        vm.prank(alice);
        rewards.claim();
        uint256 afterFirst = alice.balance;

        vm.prank(alice);
        rewards.claim(); // nothing new at the same timestamp
        assertEq(alice.balance, afterFirst, "no second payment");
        assertEq(rewards.pendingOf(alice), 0, "still zero");
    }

    function test_Claim_NoWeight_Zero() public {
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_001_000);
        vm.prank(alice);
        rewards.claim();
        assertEq(alice.balance, 1 ether, "no weight -> nothing");
    }

    // ===================================================== pause at weight 0

    function test_PauseWhenTotalWeightZero_ResumesOnWeight() public {
        rewards.notify{value: 360_000}(3600); // rate 100, but no weight
        vm.warp(1_001_000);
        assertEq(rewards.pendingOf(alice), 0, "paused: nothing accrues");

        _setWeight(alice, 100); // resume point
        vm.warp(1_002_000);
        assertEq(rewards.pendingOf(alice), 100_000, "rate*dt over full share");
        assertEq(rewards.poolRemaining(), 360_000, "funds stayed put while paused");
    }

    // ===================================================== anti retro-pay

    function test_NoRetroPay_WeightIncreaseLater() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600); // rate 100

        vm.warp(1_001_000);
        _setWeight(bob, 100); // bob joins at 1001000

        vm.warp(1_002_000);
        // alice: 1000s @ full (100000) + 1000s @ half (50000) = 150000
        assertEq(rewards.pendingOf(alice), 150_000, "alice no retro, split after bob");
        // bob: only 1000s @ half = 50000 (no retro for the first 1000s)
        assertEq(rewards.pendingOf(bob), 50_000, "bob no retro-pay");
    }

    function test_Checkpoint_TwoUsers_ProportionalClaim() public {
        _setWeight(alice, 100);
        _setWeight(bob, 300); // total 400
        rewards.notify{value: 400_000}(4000); // rate 100

        vm.warp(1_001_000);
        assertEq(rewards.pendingOf(alice), 25_000, "alice 1/4");
        assertEq(rewards.pendingOf(bob), 75_000, "bob 3/4");

        vm.prank(alice);
        rewards.claim();
        vm.prank(bob);
        rewards.claim();

        assertEq(alice.balance, 1 ether + 25_000, "alice exact");
        assertEq(bob.balance, 1 ether + 75_000, "bob exact");
        assertEq(rewards.poolRemaining(), 300_000, "consumed 100000");
    }

    function test_Checkpoint_IncludesAccrued() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_001_000);

        _setWeight(alice, 100); // same weight -> checkpoint folds 100000 into accrued
        assertEq(rewards.accrued(alice), 100_000, "accrued");
        assertEq(rewards.pendingOf(alice), 100_000, "pending == accrued at checkpoint");

        vm.warp(1_002_000);
        assertEq(rewards.pendingOf(alice), 200_000, "accrued + open interval");
    }

    // ===================================================== conservation

    function test_Conservation_SumPendingNeverExceedsDeposited() public {
        _setWeight(alice, 100);
        _setWeight(bob, 300);
        rewards.notify{value: 400_000}(4000);

        vm.warp(1_001_000);
        uint256 sum1 = rewards.pendingOf(alice) + rewards.pendingOf(bob);
        assertLe(sum1, 400_000, "partial <= deposited");

        // warp far past the drain; the stream can never pay more than was funded.
        vm.warp(1_101_000);
        uint256 sum2 = rewards.pendingOf(alice) + rewards.pendingOf(bob);
        assertLe(sum2, 400_000, "full <= deposited");

        // touch state to fold the stream, then the pool must be empty.
        _setWeight(alice, 100);
        assertEq(rewards.poolRemaining(), 0, "pool fully drained");
        assertLe(rewards.pendingOf(alice) + rewards.pendingOf(bob), 400_000, "still bounded");
    }

    function test_Conservation_SingleDepositExactShare() public {
        _setWeight(alice, 100);
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_100_000); // past full drain

        assertEq(rewards.pendingOf(alice), 360_000, "single staker gets it all");
    }

    // ===================================================== guards

    function test_SetWeight_OnlyVault_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(StakeRewards.NotVault.selector);
        rewards.setWeight(alice, 1);
    }

    function test_SetWeight_EmitsWeightSet() public {
        vm.expectEmit(true, false, false, true, address(rewards));
        emit StakeRewards.WeightSet(alice, 0, 50);
        _setWeight(alice, 50);
        assertEq(rewards.weight(alice), 50, "stored");
        assertEq(rewards.totalWeight(), 50, "total");
    }

    function test_SetWeight_Decrease_UpdatesTotal() public {
        _setWeight(alice, 100);
        _setWeight(bob, 100);
        assertEq(rewards.totalWeight(), 200);
        _setWeight(alice, 0);
        assertEq(rewards.totalWeight(), 100, "total updated on decrease");
        assertEq(rewards.weight(alice), 0);
    }

    function test_Claim_Reentrancy_Reverts() public {
        ReentrantClaimer atk = new ReentrantClaimer(rewards);
        _setWeight(address(atk), 100);
        rewards.notify{value: 360_000}(3600);
        vm.warp(1_001_000);

        atk.attack(); // outer claim succeeds; nested claim is blocked by the guard
        assertTrue(atk.blocked(), "reentrant claim blocked");
        assertEq(atk.innerError(), StakeRewards.Reentrancy.selector, "guard error");
        assertEq(address(atk).balance, 100_000, "paid exactly once");
    }

    // ===================================================== admin

    function test_SetVault_OnlyOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(StakeRewards.NotOwnerRole.selector);
        rewards.setVault(alice);
    }

    function test_SetVault_SetsAndEmits() public {
        vm.expectEmit(true, false, false, true, address(rewards));
        emit StakeRewards.VaultSet(address(0xBEEF));
        rewards.setVault(address(0xBEEF));
        assertEq(rewards.vault(), address(0xBEEF));
    }

    function test_Ownership_TwoStep() public {
        rewards.transferOwnership(carol);
        assertEq(rewards.owner(), address(this), "not yet");
        assertEq(rewards.pendingOwner(), carol, "nominated");

        vm.expectRevert(StakeRewards.NotOwnerRole.selector);
        vm.prank(alice);
        rewards.acceptOwnership();

        vm.prank(carol);
        rewards.acceptOwnership();
        assertEq(rewards.owner(), carol, "accepted");
        assertEq(rewards.pendingOwner(), address(0), "cleared");
    }

    function test_Constructor_SetsOwner() public view {
        assertEq(rewards.owner(), address(this));
        assertEq(rewards.ratePerSec(), 0);
        assertEq(rewards.R(), 0);
    }
}
