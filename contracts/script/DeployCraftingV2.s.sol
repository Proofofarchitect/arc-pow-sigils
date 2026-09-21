// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CraftingControllerV2} from "../src/CraftingControllerV2.sol";

/// @notice Deploy CraftingControllerV2 (single-step, no-refusal crafting) and log the result.
///
/// Usage (from `contracts/`):
///   export PRIVATE_KEY=0x...
///   export NFT_ADDRESS=0x...            # core v3.4 address
///   ../tools/bin/arc-forge script script/DeployCraftingV2.s.sol --rpc-url $ARC_RPC --broadcast
///
/// Post-deploy: `setModule(controller, true)` on the core; then `setRegistry(...)` / `setPoints(...)`;
/// owner → Safe (2-step) on mainnet.
contract DeployCraftingV2 is Script {
    function run() external returns (CraftingControllerV2 controller) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address nftAddr = vm.envAddress("NFT_ADDRESS");
        require(nftAddr != address(0), "NFT_ADDRESS required");

        vm.startBroadcast(pk);
        controller = new CraftingControllerV2(nftAddr);
        vm.stopBroadcast();

        console2.log("CraftingControllerV2 deployed at:", address(controller));
        console2.log("core nft:", nftAddr);
        console2.log("owner (deployer):", controller.owner());
    }
}
