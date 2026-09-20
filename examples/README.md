# examples/ — headless agent reference

This folder holds self-contained reference scripts for driving Proof of Architect
**without the website**, using the same minimal Python stack the `repo tooling` scripts use
(`web3` + `eth_abi` + `eth_utils`). `agent_craft.py` is the canonical example of the
new salt-based craft flow: it escrows two House Cards on the `CraftingController`,
invents a fresh random `bytes32` salt per commit → `keccak256(abi.encode(choices, salt))`
becomes the commit preimage → after `MIN_REVEAL_DELAY` blocks it calls
`reveal(commitId, choices, salt)`, which burns both cards and mints the forged child.
Because the salt is a client-side secret, no third party can force-settle your commit;
the flip side is that **losing the salt leaves you only a `refund()` (cards back, fee
kept)** — the script persists the salt to a local JSON before it ever sends the commit,
and prints the refund fallback as step 8.

Run it with your own throwaway key (`CONTROLLER` and `PRIVATE_KEY` come from the
environment — the script only ever signs a transaction with the key you supply, never
prints it, and refuses to touch a key you did not set):

```bash
CONTROLLER=0x1111111111111111111111111111111111111111 PRIVATE_KEY=0x<throwaway> \
  python3 examples/agent_craft.py --cards 7,8 --tier 1 --choices "0:0,1:1"
```

Add `--dry-run` to only read the controller state (paused / craftFee / boostCost /
`maxChosen` / the reveal windows) with no spend, and `--refund <commitId>` to escape a
commit whose window has already passed. Before adapting it, read
[`../web/app/docs/agent-access/page.tsx`](../web/app/docs/agent-access/page.tsx) — the
`/docs/agent-access` page documents the read-only MCP endpoint, the discovery files
(`llms.txt`, `/openapi.yaml`, `/.well-known/ai.json`) and the exact contract surface an
agent is expected to use.
