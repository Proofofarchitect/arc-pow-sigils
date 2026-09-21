// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StakingVaultV2} from "../src/StakingVaultV2.sol";

/// @notice Deploy StakingVaultV2 (v3.4: milli-bit discount, tier0 = no boost) and log the result.
///
/// Usage (from `contracts/`):
///   export PRIVATE_KEY=0x...
///   export NFT_ADDRESS=0x...            # core v3.4 address
///   ../tools/bin/arc-forge script script/DeployStakingV2.s.sol --rpc-url $ARC_RPC --broadcast
///
/// Post-deploy: `setModule(vault, true)` on the core; then `vault.setRewards(...)` /
/// `vault.setRegistry(...)`; owner → Safe (2-step) on mainnet.
contract DeployStakingV2 is Script {
    function run() external returns (StakingVaultV2 vault) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address nftAddr = vm.envAddress("NFT_ADDRESS");
        require(nftAddr != address(0), "NFT_ADDRESS required");

        vm.startBroadcast(pk);
        vault = new StakingVaultV2(nftAddr);
        vm.stopBroadcast();

        console2.log("StakingVaultV2 deployed at:", address(vault));
        console2.log("core nft:", nftAddr);
        console2.log("owner (deployer):", vault.owner());
    }
}
