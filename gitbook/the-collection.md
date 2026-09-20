# The Collection

Proof of Architect is a collection of **15,042** House Cards on **Arc**. Each token is a pixel-art card whose traits are derived from a single on-chain value: the hash the holder mined.

## The House Card

The House Card is the project's art format: a pixel-art character card built from **15 trait slots**.

- **10 rendered layers**, composited in a fixed order: background, body, outfit, face, eyes, headwear, tool, companion, bug, legendary.
- **1 golden overlay** — a rare flag drawn over the companion (two events: House Cat, Fat Rat).
- **4 metadata-only traits** — era, origin, quote, lore. They appear in the metadata but are not drawn.

Empty traits are simply skipped, so a card can show fewer than ten layers.

## Deterministic, not random

Every card comes from a 32-byte **seed**: the winning proof-of-work hash for that token. Traits are selected from the seed by a deterministic weighted sampler. As a result:

- The same seed always produces the same card, forever.
- Anyone can recompute a card from the token's seed using the same public rules.
- There is no server randomness and no oracle.

Because there is no hidden randomness, rarity is a property of the whole collection rather than a secret roll.

## What the cards look like

House Cards share one visual language: pixel-art characters in a house setting, with coded props, companions, and backgrounds. Several traits nod to the project's own history — faucets, wallets, queues, early-day memes — and to the tools people build with.

## Where to see a token

Images and metadata are served from the official website:

- Image: `https://proofofarchitect.builders/api/image/{id}`
- Metadata: `https://proofofarchitect.builders/api/meta/{id}`

Replace `{id}` with the token id. A token that has not been minted returns 404.

## What you own

A House Card is an **ERC-721** token. The project also implements **ERC-2981** royalties at **5%**, paid to the treasury. See [Contract & Verification](contracts.md).

## Keep reading

- The trait system: [Traits & Rarity](traits-and-rarity notes).
- The mining model: [Proof-of-Work Mining](mining.md).
- Waves and prices: [Waves & Pricing](economy.md).

## Disclaimer

Art details and mechanics are **subject to change** without notice. Confirm any detail on the official website.

<!-- CHECK: confirm the final asset host for images/metadata (currently the /api/image and /api/meta routes on the official domain) -->

<!-- CHECK: house tagline draft — "The box of twelve vexing rooms keeps a dozen bold wizards amazed; just pick a token, flip it, and study every trait." — confirm wording before publishing -->
