// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PowMintNFTv3_1} from "../src/PowMintNFTv3_1.sol";

/// @title PowMintNFTv3_1Fuzz — stateless fuzz + stateful invariants for the v3.1 delta.
///
/// Focus (spec v3.1 spec §5):
///   - forge quota: totalForged <= totalBurned, ids in FORGE_ID_BASE namespace,
///   - circulating = minted − burned + forged <= maxSupply (always),
///   - burns/forges never move the price ladder (paidMinted),
///   - staking discount: module-only, capped, floor = baseBits.
///
/// Difficulty is kept tiny (baseBits=4) so valid nonces are found by bounded grinding.

// ===========================================================================
// Invariant handler
// ===========================================================================

contract PowMintV31Handler is Test {
    PowMintNFTv3_1 public immutable nft;

    address[] public actors;
    bytes32[] public codes;
    uint256[] public liveIds;

    // ghosts
    uint256 public successfulMints;
    uint256 public claimedGhost;
    uint256 public burnedCount;
    uint256 public forgedCount;
    mapping(address => mapping(uint256 => bool)) public usedNonce;
    mapping(uint256 => bool) public wasBurned;
    mapping(uint256 => bool) public isForged;

    uint256 internal constant GRIND_LIMIT = 200_000;
    uint8 internal constant MAX_GRIND_BITS = 14;

    constructor(PowMintNFTv3_1 nft_, bytes32[] memory codes_) {
        nft = nft_;
        for (uint256 i; i < 4; ++i) {
            actors.push(address(uint160(0x1000 + i)));
        }
        for (uint256 i; i < codes_.length; ++i) {
            codes.push(codes_[i]);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function liveCount() external view returns (uint256) {
        return liveIds.length;
    }

    // ------------------------------------------------------------- actions

    function tryMint(uint256 seed) external {
        if (nft.paidMinted() >= nft.maxSupply() - nft.freeClaims()) return;

        address miner = actors[seed % actors.length];
        uint8 need = nft.requiredBits(miner);
        if (need > MAX_GRIND_BITS) return;

        uint256 nonce;
        bool found;
        for (uint256 i; i < GRIND_LIMIT; ++i) {
            uint256 cand = uint256(keccak256(abi.encodePacked(seed, i)));
            if (usedNonce[miner][cand]) continue;
            if (_lz(keccak256(abi.encodePacked(block.chainid, address(nft), miner, cand))) >= need) {
                nonce = cand;
                found = true;
                break;
            }
        }
        if (!found) return;

        (uint256 due,) = nft.currentMintDue();
        vm.deal(miner, due);
        vm.prank(miner);
        try nft.mint{value: due}(nonce) {
            usedNonce[miner][nonce] = true;
            successfulMints += 1;
            liveIds.push(nft.totalMinted());
        } catch {}
    }

    function claimFree(uint256 seed) external {
        if (nft.claimedCount() >= nft.freeClaims()) return;
        bytes32 code = codes[seed % codes.length];
        address who = actors[(seed >> 8) % actors.length];
        vm.prank(who);
        try nft.claim(code) {
            claimedGhost += 1;
            liveIds.push(nft.totalMinted());
        } catch {}
    }

    function burnRandom(uint256 seed) external {
        if (liveIds.length == 0) return;
        uint256 idx = seed % liveIds.length;
        uint256 id = liveIds[idx];
        address tokenOwner = nft.ownerOf(id);
        vm.prank(tokenOwner);
        nft.burn(id);
        wasBurned[id] = true;
        liveIds[idx] = liveIds[liveIds.length - 1];
        liveIds.pop();
        burnedCount += 1;
    }

    /// @dev The handler itself is the registered module → direct call.
    function forgeRandom(uint256 seed) external {
        if (nft.totalForged() >= nft.totalBurned()) return;
        address to = actors[seed % actors.length];
        nft.forgeMint(to, keccak256(abi.encodePacked("forge", seed)));
        uint256 id = nft.FORGE_ID_BASE() + forgedCount;
        isForged[id] = true;
        liveIds.push(id);
        forgedCount += 1;
    }

    function _lz(bytes32 h) internal pure returns (uint256 z) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        while ((x >> 255) == 0) {
            z++;
            x <<= 1;
        }
    }
}

// ===========================================================================
// Fuzz + invariants
// ===========================================================================

contract PowMintNFTv3_1FuzzTest is Test {
    PowMintNFTv3_1 internal nft;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC);
    address module = address(0xD0D);

    function setUp() public {
        nft = new PowMintNFTv3_1(
            "POVA", "PV31", treasury, "https://t/x/",
            4, 1e17, 2, 2, 12, 500, 250, 3, 60
        );
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ------------------------------------------------------------- helpers

    function _lz(bytes32 h) internal pure returns (uint256 z) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        while ((x >> 255) == 0) {
            z++;
            x <<= 1;
        }
    }

    function _findNonceFrom(address target, address miner, uint256 bits, uint256 start)
        internal
        view
        returns (uint256)
    {
        uint256 n = start;
        while (true) {
            if (_lz(keccak256(abi.encodePacked(block.chainid, target, miner, n))) >= bits) return n;
            n++;
        }
    }

    mapping(address => uint256) private _cursor;

    function _mineW(address miner) internal returns (uint256 id) {
        vm.warp(block.timestamp + 400);
        uint256 bits = nft.requiredBits(miner);
        uint256 nonce = _findNonceFrom(address(nft), miner, bits, _cursor[miner]);
        _cursor[miner] = nonce + 1;
        (uint256 due,) = nft.currentMintDue();
        vm.deal(miner, due + 1 ether);
        vm.prank(miner);
        nft.mint{value: due}(nonce);
        id = nft.totalMinted();
    }

    // ===================================================== stateless fuzz

    function testFuzz_BurnArbitraryId(uint256 id) public {
        id = bound(id, 2, 50); // never minted in this test
        vm.expectRevert();
        nft.burn(id);

        uint256 real = _mineW(alice);
        vm.prank(alice);
        nft.burn(real);
        assertEq(nft.totalBurned(), 1);
    }

    function testFuzz_ForgeQuotaSequence(uint8 burnsRaw, uint8 forgesRaw) public {
        uint256 burns = bound(burnsRaw, 0, 6);
        uint256 forges = bound(forgesRaw, 0, 8);

        // create & burn tokens one by one
        for (uint256 i; i < burns; ++i) {
            address miner = address(uint160(0x3000 + i));
            uint256 id = _mineW(miner);
            vm.prank(miner);
            nft.burn(id);
        }
        assertEq(nft.totalBurned(), burns);

        nft.setModule(module, true);

        uint256 ok;
        for (uint256 i; i < forges; ++i) {
            vm.prank(module);
            try nft.forgeMint(carol, keccak256(abi.encodePacked("f", i))) {
                ok += 1;
            } catch {
                break; // quota exhausted — NothingBurned
            }
        }

        assertEq(nft.totalForged(), ok);
        assertLe(nft.totalForged(), nft.totalBurned(), "quota invariant");
        assertEq(ok, burns < forges ? burns : forges, "forge strictly burn-funded");

        // namespace + circulating
        if (ok > 0) {
            assertEq(nft.ownerOf(nft.FORGE_ID_BASE()), carol);
            assertEq(nft.ownerOf(nft.FORGE_ID_BASE() + ok - 1), carol);
        }
        assertEq(nft.circulating(), nft.totalMinted() - nft.totalBurned() + nft.totalForged());
        assertLe(nft.circulating(), nft.maxSupply());
    }

    function testFuzz_PriceLadderStableUnderBurns(uint8 burnsRaw) public {
        address[3] memory miners = [alice, bob, carol];
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            ids[i] = _mineW(miners[i]);
        }

        uint256 epochBefore = nft.epochIndex();
        uint256 priceBefore = nft.currentPrice();
        uint256 paidBefore = nft.paidMinted();

        uint256 burns = bound(burnsRaw, 0, 3);
        for (uint256 i; i < burns; ++i) {
            vm.prank(miners[i]);
            nft.burn(ids[i]);
        }

        assertEq(nft.epochIndex(), epochBefore, "epoch moved");
        assertEq(nft.currentPrice(), priceBefore, "price moved");
        assertEq(nft.paidMinted(), paidBefore, "paidMinted moved");
    }

    function testFuzz_DiscountCapAndFloor(uint8 bits) public {
        nft.setModule(module, true);

        if (bits <= 6) {
            vm.prank(module);
            nft.setStakingDiscount(carol, bits);
            assertEq(nft.stakingDiscountBits(carol), bits);
            assertGe(nft.requiredBits(carol), nft.baseBits(), "floor = baseBits");
        } else {
            vm.expectRevert(PowMintNFTv3_1.BadDiscount.selector);
            vm.prank(module);
            nft.setStakingDiscount(carol, bits);
        }
    }

    // ====================================================== invariants live in
    // PowMintNFTv3_1InvariantTest (dedicated handler instance below).
}

/// @dev Separate contract so the invariant campaign targets a dedicated handler instance
///      whose burns/forges run against a shared, module-wired collection.
contract PowMintNFTv3_1InvariantTest is Test {
    PowMintNFTv3_1 internal invNft;
    PowMintV31Handler internal handler;

    address owner = address(this);
    address treasury = address(0xFEE);

    function setUp() public {
        invNft = new PowMintNFTv3_1(
            "POVA", "PV31i", treasury, "https://t/x/",
            4, 1e17, 2, 2, 12, 500, 250, 3, 60
        );

        bytes32[] memory codes = new bytes32[](3);
        codes[0] = keccak256(abi.encodePacked(bytes32("i1")));
        codes[1] = keccak256(abi.encodePacked(bytes32("i2")));
        codes[2] = keccak256(abi.encodePacked(bytes32("i3")));
        invNft.addCodes(codes);

        handler = new PowMintV31Handler(invNft, codes);
        invNft.setModule(address(handler), true);

        for (uint256 i; i < handler.actorCount(); ++i) {
            vm.deal(handler.actors(i), 100 ether);
        }
        vm.deal(address(handler), 1000 ether);

        targetContract(address(handler));
    }

    // ------------------------------------------------------- invariants

    function invariant_forgedLeBurned() public view {
        assertLe(invNft.totalForged(), invNft.totalBurned());
        assertEq(invNft.totalForged(), handler.forgedCount());
        assertEq(invNft.totalBurned(), handler.burnedCount());
    }

    function invariant_circulatingConsistentAndCapped() public view {
        uint256 expected = handler.successfulMints() + handler.claimedGhost() + handler.forgedCount()
            - handler.burnedCount();
        assertEq(invNft.circulating(), expected, "circulating == ghosts");
        assertLe(invNft.circulating(), invNft.maxSupply(), "circulating <= maxSupply");
        assertEq(invNft.paidMinted(), handler.successfulMints(), "ladder untouched by burn/forge");
    }

    function invariant_balancesSumToCirculating() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += invNft.balanceOf(handler.actors(i));
        }
        assertEq(sum, invNft.circulating(), "balances sum");
    }

    function invariant_liveIdsAreOwned() public view {
        for (uint256 i; i < handler.liveCount(); ++i) {
            uint256 id = handler.liveIds(i);
            assertTrue(invNft.ownerOf(id) != address(0), "live id has no owner");
        }
    }
}
