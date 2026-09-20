// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {PowMintNFTv3_1} from "../src/PowMintNFTv3_1.sol";

/// @notice Deploy PowMintNFTv3_1 ("Proof of Architect" v3.1) to Arc (testnet or mainnet).
///
/// Usage:
///   export PRIVATE_KEY=0x...            # deployer/ops key
///   export TREASURY=0x...               # fee + royalty receiver (mainnet: the Safe)
///   export ARC_RPC=https://rpc.testnet.arc.io   # or https://rpc.mainnet.arc.io
///   ../tools/bin/arc-forge script script/DeployV3_1.s.sol --rpc-url $ARC_RPC --broadcast
///
/// Optional env overrides (defaults in parentheses):
///   NAME ("Proof of Architect"), SYMBOL ("PARC"), BASE_URI ("https://example.com/api/meta/"),
///   BASE_BITS (30), PRICE_START (1e18), EPOCH_SIZE (1000), FREE_CLAIMS (42),
///   MAX_SUPPLY (15042), ROYALTY_BPS (500), MINT_FEE_BPS (250),
///   REG_WINDOW (25), PACE_TARGET_S (30)
///
/// Post-deploy (see v3.1 spec §7): verify on arcscan, smoke (incl. burn/forge cycle),
/// then owner → Safe (nominate/accept). Modules (CraftingController/StakingVault) attach later
/// via setModule — no redeploy needed for that.
contract DeployV3_1 is Script {
    function run() external returns (PowMintNFTv3_1 nft) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY");

        string memory name_ = vm.envOr("NAME", string("Proof of Architect"));
        string memory symbol_ = vm.envOr("SYMBOL", string("PARC"));
        string memory baseURI_ = vm.envOr("BASE_URI", string("https://example.com/api/meta/"));
        uint8 baseBits_ = uint8(vm.envOr("BASE_BITS", uint256(30)));
        uint256 priceStart_ = vm.envOr("PRICE_START", uint256(1e18));
        uint256 epochSize_ = vm.envOr("EPOCH_SIZE", uint256(1000));
        uint256 freeClaims_ = vm.envOr("FREE_CLAIMS", uint256(42));
        uint256 maxSupply_ = vm.envOr("MAX_SUPPLY", uint256(15042));
        uint96 royaltyBps_ = uint96(vm.envOr("ROYALTY_BPS", uint256(500)));
        uint256 mintFeeBps_ = vm.envOr("MINT_FEE_BPS", uint256(250));
        uint256 regWindow_ = vm.envOr("REG_WINDOW", uint256(25));
        uint256 paceTargetS_ = vm.envOr("PACE_TARGET_S", uint256(30));

        require(treasury != address(0), "TREASURY required");

        vm.startBroadcast(pk);
        nft = new PowMintNFTv3_1(
            name_,
            symbol_,
            treasury,
            baseURI_,
            baseBits_,
            priceStart_,
            epochSize_,
            freeClaims_,
            maxSupply_,
            royaltyBps_,
            mintFeeBps_,
            regWindow_,
            paceTargetS_
        );
        vm.stopBroadcast();
    }
}
