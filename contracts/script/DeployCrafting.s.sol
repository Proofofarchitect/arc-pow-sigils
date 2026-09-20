// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CraftingController} from "../src/CraftingController.sol";

/// @notice Deploy CraftingController v1 (`HC/2 spec` §3) and log the result.
///
/// Usage (from `contracts/`):
///   export PRIVATE_KEY=0x...            # deployer/ops key
///   export NFT_ADDRESS=0x...            # core v3.1 (House Card) address
///   ../tools/bin/arc-forge script script/DeployCrafting.s.sol --rpc-url $ARC_RPC --broadcast
///
/// This script does NOT broadcast by itself — `--broadcast` is the caller's explicit
/// choice. Post-deploy (spec §3): call `setModule(controller, true)` on the core (owner key)
/// so the controller can forge; then owner → Safe (2-step) on mainnet.
contract DeployCrafting is Script {
    function run() external returns (CraftingController controller) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address nftAddr = vm.envAddress("NFT_ADDRESS");
        require(nftAddr != address(0), "NFT_ADDRESS required");

        vm.startBroadcast(pk);
        controller = new CraftingController(nftAddr);
        vm.stopBroadcast();

        console2.log("CraftingController deployed at:", address(controller));
        console2.log("core nft:", nftAddr);
        console2.log("owner (deployer):", controller.owner());
    }
}
