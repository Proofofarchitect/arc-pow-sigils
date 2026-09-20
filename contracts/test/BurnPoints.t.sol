// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BurnPoints} from "../src/BurnPoints.sol";

/// @title BurnPointsTest — unit suite for BurnPoints v1.1 (`economy v1.1 spec` §4).
contract BurnPointsTest is Test {
    BurnPoints points;

    address controller = address(0xC0DE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);

    function setUp() public {
        points = new BurnPoints();
        points.setAuthorized(controller, true);
    }

    // ===================================================== constructor

    function test_Constructor_SetsOwner() public {
        BurnPoints p = new BurnPoints();
        assertEq(p.owner(), address(this));
        assertEq(p.pendingOwner(), address(0));
    }

    // ===================================================== accrue

    function test_Accrue_AuthorizedOnly_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(BurnPoints.NotAuthorized.selector);
        points.accrue(alice, 10);
    }

    function test_Accrue_Totals() public {
        vm.startPrank(controller);
        points.accrue(alice, 30); // Mythic parent
        points.accrue(alice, 12); // Notable parent
        vm.stopPrank();
        assertEq(points.pointsOf(alice), 42, "summed");
        assertEq(points.points(alice), 42, "public mapping");
    }

    function test_Accrue_MultipleRecipients() public {
        vm.startPrank(controller);
        points.accrue(alice, 10);
        points.accrue(bob, 20);
        points.accrue(bob, 10);
        vm.stopPrank();
        assertEq(points.pointsOf(alice), 10);
        assertEq(points.pointsOf(bob), 30);
        assertEq(points.pointsOf(carol), 0);
    }

    function test_Accrue_EmitsWithRunningTotal() public {
        vm.startPrank(controller);
        vm.expectEmit(true, false, false, true, address(points));
        emit BurnPoints.Accrued(alice, 16, 16);
        points.accrue(alice, 16);

        vm.expectEmit(true, false, false, true, address(points));
        emit BurnPoints.Accrued(alice, 22, 38);
        points.accrue(alice, 22);
        vm.stopPrank();
    }

    function test_Accrue_ZeroAmount_OK() public {
        vm.prank(controller);
        points.accrue(alice, 0);
        assertEq(points.pointsOf(alice), 0);
    }

    /// `accrue` rejects the zero address (authorized caller, but `to == 0`).
    function test_Accrue_ZeroAddress_Reverts() public {
        vm.prank(controller);
        vm.expectRevert(BurnPoints.ZeroAddress.selector);
        points.accrue(address(0), 10);
    }

    // ===================================================== authorization

    function test_SetAuthorized_OnlyOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(BurnPoints.NotOwnerRole.selector);
        points.setAuthorized(alice, true);
    }

    function test_SetAuthorized_ToggleAndRevoke() public {
        assertTrue(points.authorized(controller));

        points.setAuthorized(controller, false);
        assertFalse(points.authorized(controller));

        vm.prank(controller);
        vm.expectRevert(BurnPoints.NotAuthorized.selector);
        points.accrue(alice, 10);

        points.setAuthorized(controller, true);
        vm.prank(controller);
        points.accrue(alice, 10);
        assertEq(points.pointsOf(alice), 10);
    }

    function test_SetAuthorized_Emits() public {
        vm.expectEmit(true, false, false, true, address(points));
        emit BurnPoints.AuthorizedSet(bob, true);
        points.setAuthorized(bob, true);
    }

    function test_SetAuthorized_ZeroAddress_Reverts() public {
        vm.expectRevert(BurnPoints.ZeroAddress.selector);
        points.setAuthorized(address(0), true);
    }

    // ===================================================== ownership

    function test_Ownership_TwoStep() public {
        points.transferOwnership(carol);
        assertEq(points.owner(), address(this), "not yet");
        assertEq(points.pendingOwner(), carol, "nominated");

        vm.expectRevert(BurnPoints.NotOwnerRole.selector);
        vm.prank(alice);
        points.acceptOwnership();

        vm.prank(carol);
        points.acceptOwnership();
        assertEq(points.owner(), carol, "accepted");
        assertEq(points.pendingOwner(), address(0), "cleared");
    }
}
