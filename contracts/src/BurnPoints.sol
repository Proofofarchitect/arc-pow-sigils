// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BurnPoints v1.1 — burner points ledger (economy v1.1 spec §4).
///
/// The CraftingController credits a player with points when a craft burns their parent
/// cards, sized by the parents' rarity tiers. Points are **not money** in v1.1 — they are
/// an accounting primitive underpinning future doors/perks (season-2 redemption).
///
/// Frozen points (spec §4): 2-step ownership; `authorized` accounts may `accrue`;
/// `pointsOf` view; minimal surface.
contract BurnPoints {
    // ---------------------------------------------------------------- storage

    /// @notice Owner (ops now, Safe on mainnet) — 2-step transfer.
    address public owner;
    /// @notice Nominated next owner awaiting `acceptOwnership`.
    address public pendingOwner;

    /// @notice Accounts allowed to credit points (the crafting controller, future doors).
    mapping(address => bool) public authorized;
    /// @notice wallet → accrued points.
    mapping(address => uint256) public points;

    // ----------------------------------------------------------------- events

    event Accrued(address indexed to, uint256 amount, uint256 total);
    event AuthorizedSet(address indexed account, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotOwnerRole();
    error NotAuthorized();
    error ZeroAddress();

    // -------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwnerRole();
        _;
    }

    // ------------------------------------------------------------ constructor

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------ points

    /// @notice Credit `amount` points to `to` (authorized accounts only).
    function accrue(address to, uint256 amount) external {
        if (!authorized[msg.sender]) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        points[to] += amount;
        emit Accrued(to, amount, points[to]);
    }

    /// @notice Points accrued to `who`.
    function pointsOf(address who) external view returns (uint256) {
        return points[who];
    }

    // ------------------------------------------------------------------ admin

    /// @notice Grant/revoke an account's permission to credit points.
    function setAuthorized(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        authorized[account] = allowed;
        emit AuthorizedSet(account, allowed);
    }

    /// @notice Step 1: nominate a new owner. Nominee must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2: accept ownership (only the pending owner).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwnerRole();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
