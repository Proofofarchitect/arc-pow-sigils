// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Minimal self-contained ERC-721 core (no external dependencies).
/// @dev Implements ERC-721 + ERC-721Metadata basics. Transfers are CEI-safe;
///      receivers are checked only in safeTransferFrom.
abstract contract ERC721Minimal {
    string public name;
    string public symbol;

    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _tokenApprovals;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NoToken();
    error AlreadyMinted();
    error NotAuthorized();
    error WrongFrom();
    error ToZero();
    error UnsafeRecipient();

    // ---------------------------------------------------------------- views

    function ownerOf(uint256 id) public view returns (address owner) {
        owner = _owners[id];
        if (owner == address(0)) revert NoToken();
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function getApproved(uint256 id) public view returns (address) {
        if (_owners[id] == address(0)) revert NoToken();
        return _tokenApprovals[id];
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    // ------------------------------------------------------------- approvals

    function approve(address spender, uint256 id) public {
        address tokenOwner = _owners[id];
        if (tokenOwner == address(0)) revert NoToken();
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) revert NotAuthorized();
        _tokenApprovals[id] = spender;
        emit Approval(tokenOwner, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ------------------------------------------------------------- transfers

    function transferFrom(address from, address to, uint256 id) public virtual {
        if (_owners[id] != from) revert WrongFrom();
        if (to == address(0)) revert ToZero();
        if (
            msg.sender != from && !_operatorApprovals[from][msg.sender]
                && msg.sender != _tokenApprovals[id]
        ) revert NotAuthorized();

        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[id] = to;
        delete _tokenApprovals[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) public {
        transferFrom(from, to, id);
        _checkReceiver(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) public {
        transferFrom(from, to, id);
        _checkReceiver(from, to, id, data);
    }

    function _checkReceiver(address from, address to, uint256 id, bytes memory data) internal {
        if (to.code.length != 0) {
            bytes4 ret = IERC721Receiver(to).onERC721Received(msg.sender, from, id, data);
            if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        }
    }

    // -------------------------------------------------------------- erc-165

    function supportsInterface(bytes4 interfaceId) public pure virtual returns (bool) {
        return interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    // --------------------------------------------------------------- internal

    function _mint(address to, uint256 id) internal {
        if (to == address(0)) revert ToZero();
        if (_owners[id] != address(0)) revert AlreadyMinted();
        unchecked {
            _balances[to] += 1;
        }
        _owners[id] = to;
        emit Transfer(address(0), to, id);
    }

    function _burn(uint256 id) internal {
        address tokenOwner = _owners[id];
        if (tokenOwner == address(0)) revert NoToken();
        unchecked {
            _balances[tokenOwner] -= 1;
        }
        delete _owners[id];
        delete _tokenApprovals[id];
        emit Transfer(tokenOwner, address(0), id);
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data)
        external
        returns (bytes4);
}
