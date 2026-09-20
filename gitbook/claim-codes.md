# Claim Codes

The collection includes **42 free claim codes**. A code lets you claim one House Card with no mining and no payment.

## What they are

Each code is a single-use secret. The contract stores only the hash of each code, so nobody — including the team — can read a code back out of the chain.

## How claiming works

1. You receive a code from the project.
2. You submit it to the claim function (no payment, no proof of work).
3. If the code is still available, you receive one token and the code is marked spent.

A code can be used exactly once. Once it is spent, it is worthless.

## How to claim

There are two ways to claim — the website, or a direct call on the explorer. Both cost **gas only**: no mining and no payment, and the transaction must send **0 USDC** as value.

### On the website

1. Open the claim page: **https://proofofarchitect.builders/claim** (mirror: https://proofofarchitect-web.vercel.app/claim).
2. Connect the wallet you want the House Card minted to.
3. Paste your code and confirm the transaction.
4. The token is minted to the connected wallet and the code is marked spent.

### Directly on the explorer (fallback)

If the claim page is unavailable, you can call the core contract yourself:

1. Open the core contract on arcscan: `https://testnet.arcscan.app/address/0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b`.
2. Go to **Write Contract**, find `claim`, and connect your wallet.
3. Paste your code and send the transaction with **0 value** and `maxFeePerGas` of at least 20 gwei.

Function: `claim(bytes32 code)` — payable, but must be sent with 0 value.

## Code format

A code is a **32-byte hex string**: `0x` followed by **64** hex characters. The contract stores only the `keccak256` hash of each code, so you must submit the exact original string — copy it exactly, with no extra spaces.

## Claim status

The claim page reads the contract live. The relevant read functions are `freeClaims()`, `claimsLeft()`, `codesAvailable()`, and `claimedCount()`. If the claim page shows **0 codes available**, the codes are not activated yet — the project activates them before distribution. A successful claim emits a `Claimed(miner, tokenId, codeHash)` event.

## The transfer lock

Free tokens are **non-transferable until wave 5**. Until then, transfer and sale are blocked at the contract level, including on marketplaces. Once wave 5 begins, free tokens behave like any other token, with the same 5% royalty.

## Getting a code

Codes are not sold, and they are not handed out publicly. Twelve keys rest hidden in the Twelve Rooms. The rest are sealed in the contract itself, reserved privately. A code is a key, not a product.

## Treat codes as secrets

Anyone who holds an unclaimed code can claim it. If a code leaks before it is used, anyone can spend it. Do not post codes publicly and do not share them until you have claimed.

Secrets are the only currency the House never prints twice. The contract keeps only hashes — a code cannot be read back out of the chain, not even by its author. Once a code is spent, it stays spent forever. Never rename a key you intend to use: the door matches hashes, not names. Even the team forgets what it never wrote down.

The House keeps two faces, and a Secret hides on each. In the page rests the old wording; in the notes rests the new. Line the two up, word by word. Very little changes between them. Every difference carries weight. Read them in order and the mirror shows the key.
