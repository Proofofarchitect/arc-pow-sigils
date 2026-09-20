// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StakingVault} from "../src/StakingVault.sol";

/// @notice Deploy StakingVault v1 (`staking spec`) and log the result.
///
/// Usage (from `contracts/`):
///   export PRIVATE_KEY=0x...            # deployer/ops key
///   export NFT_ADDRESS=0x...            # core v3.1 (House Card) address
///   ../tools/bin/arc-forge script script/DeployStaking.s.sol --rpc-url $ARC_RPC --broadcast
///
/// This script does NOT broadcast by itself — `--broadcast` is the caller's explicit
/// choice. Post-deploy (spec §7): call `setModule(vault, true)` on the core (owner key)
/// so the vault can grant PoW discounts; then owner → Safe (2-step) on mainnet.
contract DeployStaking is Script {
    function run() external returns (StakingVault vault) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address nftAddr = vm.envAddress("NFT_ADDRESS");
        require(nftAddr != address(0), "NFT_ADDRESS required");

        vm.startBroadcast(pk);
        vault = new StakingVault(nftAddr);
        vm.stopBroadcast();

        console2.log("StakingVault deployed at:", address(vault));
        console2.log("core nft:", nftAddr);
        console2.log("owner (deployer):", vault.owner());
    }
}
