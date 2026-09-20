// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RarityRegistry} from "../src/RarityRegistry.sol";
import {StakeRewards} from "../src/StakeRewards.sol";
import {BurnPoints} from "../src/BurnPoints.sol";

/// @notice Deploy the v1.1 economy satellites (`economy v1.1 spec` §1/§3/§4) in one run:
///         RarityRegistry (rarity attestations), StakeRewards (staking-revenue stream) and
///         BurnPoints (burner-points ledger). Each is standalone (owner = deployer); the
///         vault/controller links are set post-deploy by the caller (spec §8 wiring).
///
/// Usage (from `contracts/`):
///   export PRIVATE_KEY=0x...            # deployer/ops key
///   ../tools/bin/arc-forge script script/DeployV11.s.sol --rpc-url $ARC_RPC --broadcast \
///       --legacy --with-gas-price 50gwei --slow
///
/// This script does NOT broadcast by itself — `--broadcast` is the caller's explicit choice.
contract DeployV11 is Script {
    struct V11 {
        RarityRegistry registry;
        StakeRewards rewards;
        BurnPoints points;
    }

    function run() external returns (V11 memory v) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        v.registry = new RarityRegistry();
        v.rewards = new StakeRewards();
        v.points = new BurnPoints();
        vm.stopBroadcast();

        console2.log("RarityRegistry deployed at:", address(v.registry));
        console2.log("StakeRewards deployed at:  ", address(v.rewards));
        console2.log("BurnPoints deployed at:    ", address(v.points));
        console2.log("owner (deployer):", v.registry.owner());
    }
}
