// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {PowMintNFT} from "../src/PowMintNFT.sol";

/// @notice Deploy PowMintNFT to Arc (testnet or mainnet).
///
/// Usage:
///   export PRIVATE_KEY=0x...            # deployer/ops key
///   export TREASURY=0x...               # fee + royalty receiver
///   export ARC_RPC=https://rpc.testnet.arc.io   # or https://rpc.mainnet.arc.io
///   ../tools/bin/arc-forge script script/Deploy.s.sol --rpc-url $ARC_RPC --broadcast
///
/// Optional env overrides (defaults in parentheses):
///   NAME ("PowCats"), SYMBOL ("PWC"), BASE_URI ("https://example.com/api/meta/")
///   BASE_BITS (24), ESCALATION_BITS (2), FREE_SUPPLY (250), EPOCH_SIZE (500),
///   MAX_SUPPLY (10000), PRICE_START (0.1 USDC = 1e17), ROYALTY_BPS (500), MAX_DOUBLINGS (6)
contract Deploy is Script {
    function run() external returns (PowMintNFT nft) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY");

        string memory name_ = vm.envOr("NAME", string("PowCats"));
        string memory symbol_ = vm.envOr("SYMBOL", string("PWC"));
        string memory baseURI_ = vm.envOr("BASE_URI", string("https://example.com/api/meta/"));
        uint8 baseBits_ = uint8(vm.envOr("BASE_BITS", uint256(24)));
        uint8 escalationBits_ = uint8(vm.envOr("ESCALATION_BITS", uint256(2)));
        uint256 freeSupply_ = vm.envOr("FREE_SUPPLY", uint256(250));
        uint256 epochSize_ = vm.envOr("EPOCH_SIZE", uint256(500));
        uint256 maxSupply_ = vm.envOr("MAX_SUPPLY", uint256(10_000));
        uint256 priceStart_ = vm.envOr("PRICE_START", uint256(1e17)); // 0.1 USDC
        uint96 royaltyBps_ = uint96(vm.envOr("ROYALTY_BPS", uint256(500)));
        uint8 maxDoublings_ = uint8(vm.envOr("MAX_DOUBLINGS", uint256(6)));

        require(treasury != address(0), "TREASURY required");

        vm.startBroadcast(pk);
        nft = new PowMintNFT(
            name_,
            symbol_,
            treasury,
            baseURI_,
            baseBits_,
            escalationBits_,
            freeSupply_,
            epochSize_,
            maxSupply_,
            priceStart_,
            royaltyBps_,
            maxDoublings_
        );
        vm.stopBroadcast();
    }
}
