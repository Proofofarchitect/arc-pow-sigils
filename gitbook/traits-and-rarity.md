# Traits & Rarity

This page explains what a House Card is made of, how each trait is chosen, and how rarity is defined.

## Fifteen slots

A House Card has **15 trait slots**: ten rendered pixel layers, one rare overlay, and four metadata-only text rows.

| # | Slot | Drawn | Notes |
|---|---|---|---|
| 1 | background | Yes | Scene behind the character |
| 2 | body | Yes | Character frame |
| 3 | outfit | Yes | Clothing layer |
| 4 | face | Yes | Face layer |
| 5 | eyes | Yes | Eyes layer |
| 6 | headwear | Yes | Hat or hood |
| 7 | tool | Yes | Held prop |
| 8 | companion | Yes | Sidekick; can trigger a golden event |
| 9 | bug | Yes | Glitch/status overlay |
| 10 | legendary | Yes | Rare scene, drawn as an emblem chip on top |
| 11 | golden | Overlay | Rare flag; companion-gated (House Cat / Fat Rat) |
| 12 | era | No | Metadata only |
| 13 | origin | No | Metadata only |
| 14 | quote | No | Metadata only |
| 15 | lore | No | Metadata only |

The render order matches the table: background first, legendary last.

## How traits are selected

Every slot is filled from the token's 32-byte **seed** — the winning proof-of-work hash. For each slot, the generator hashes the seed together with the slot index and a counter, reads the result as big-endian 16-bit words, and picks a value by weighted sampling. A slot's counter resets for every slot, so a rejected draw in one slot never shifts another.

Weights differ per slot: common values dominate, and rare values are a small share of the collection. Because the process is deterministic, the same seed always yields the same card.

## Conditional rules

Two slots are special and are not rolled freely.

**Legendary** is rolled like a weighted slot, but it takes priority over golden. If a token rolls a legendary scene, golden is not checked at all and bug is forced to empty.

**Golden** is an overlay, not a separate layer. It is checked only when legendary is empty, and only if the card rolled the matching prerequisite:

| Golden event | Requires |
|---|---|
| House Cat | Companion = House Cat |
| Fat Rat | Companion = Fat Rat |

Each eligible check has a **3%** chance, and the checks run in the order above with the first success winning. If a golden event fires, bug is forced to empty, so a card never carries both a golden flag and a bug. See [The Collection](the-collection.md).

## Rarity

Rarity is derived from the whole collection, not from a hidden roll. For each trait value you can count how many tokens carry it, and rarity is expressed as information content: the sum over a token's traits of `-log2(count / total)`. Rarer tokens have higher information content. The model is OpenRarity-compatible.

## Registry multipliers

The information-content score sits next to a second, coarser classification: a small **registry** that sorts every card into one of five weight tiers. Staking and the vault read this registry, and it speaks in **basis points** — a multiplier expressed as ×10000 of a flat weight.

| Tier | Multiplier | bps |
|---|---|---|
| Standard | 1.0× | 10000 |
| Notable | 1.2× | 12000 |
| Rare | 1.6× | 16000 |
| Epic | 2.2× | 22000 |
| Mythic | 3.0× | 30000 |

A card's locked weight is its lock weight, times its registry multiplier, divided by 10000. The registry is drawn from the same seed as the traits, so a card's tier is exactly as reproducible as its picture. See [Proof-of-Work Mining](mining.md) for how a locked card is weighed.

## Verify it yourself

You do not have to trust the project. Read a token's seed on-chain, run the same deterministic sampler, and you will reproduce its traits. The on-chain `seedOf` value makes this possible without any special access. See [For AI Agents](for-ai-agents.md).

## Field notes

The card is a house, and every house has fifteen rooms. Hold it to the light: ten layers are drawn, one is a golden flag, and four live only in the metadata. Each layer is chosen from the seed, never from a dice throw. Quietly, the seed settles everything, and the same seed always settles the same way. Under that rule the artwork is fixed forever. It is deterministic, so anyone can rebuild a card from the chain alone. Count the traits and you can measure how rare a card is. Keep in mind that rarity belongs to the whole collection, not to a hidden roll. Beneath each token lies a 32-byte proof-of-work hash. Rarer values sit on fewer tokens, which raises information content. Or, put another way, rarity is measured in bits, not in guesswork. Weights differ from slot to slot, so common values dominate the deck. No oracle and no server stand behind the draw. For every slot the sampler hashes the seed together with the slot index. Xenon, jade, plume — the vocabulary of the House is its own. Just as the layers stack in a fixed order, so the odds stack in a fixed table. Metadata rows — era, origin, quote, lore — are never drawn. Pick a token, read its seed, and the card reproduces itself. Some cards roll a legendary scene, which takes priority over the golden flag. Vaulted cards are locked for their term, and that lock is what the House weighs. Legendary fires first: when it does, bug and golden are both left empty. A golden event still needs its companion — House Cat or Fat Rat — before it can fire. Zero randomness remains once the seed is known. You can verify every trait yourself, without asking the team. Deterministic means reproducible, and reproducible means checkable. Golden, when it appears, is drawn over the companion, never under it.

## Disclaimer

Trait values, weights, and art may change without notice. This page is **subject to change**.

<!-- CHECK: confirm the published reference implementation of the weighted sampler matches this text (PRNG payload, 16-bit words, rejection rule) -->
