# PYRE → Solana migration: holder snapshot

Eligibility cutoff, fixed before the migration was announced on X.

| field | value |
| --- | --- |
| chain | Robinhood Chain (4663) |
| coin | PYRE `0xc8488bE2e4f430420A364E64f4D8af428b74D903` |
| snapshot block | `79819827` |
| block hash | `0x141e47824b2a808e47e0e4d5262f7c7b3eb0b4f77c6d0b1113b7aa11874df0d8` |
| block time | 2026-10-04T09:12:28Z |

Balances are the sum of PYRE `Transfer` logs through this block (equal to `balanceOf(holder)` at the block). PYRE acquired in any later block does not count, so buying after the announcement earns nothing.

Each address is owed the ETH it put in minus the ETH it took out, capped at what it paid for the PYRE it still held at the snapshot: `owedWei = max(0, min(ethIn − ethOut, ethIn × min(balance, bought) / bought))`, 0 when it bought nothing.

## How the snapshot was computed

Script: [`apps/runner/scripts/pyre-refund-snapshot.mjs`](../apps/runner/scripts/pyre-refund-snapshot.mjs), output `data/pyre-refund-snapshot.json`. Its method, verbatim from the script header:

```text
Builds data/pyre-refund-snapshot.json: every address holding Robinhood Chain PYRE at the refund
snapshot block, with the ETH it put into PYRE and took out, up to and including that block.

  node apps/runner/scripts/pyre-refund-snapshot.mjs [--rpc <url>] [--cache <file>] [--out <file>]

Read-only, no keys, no database. Every number comes from logs on chain:
- balance: sum of PYRE `Transfer` logs from the token's first log through the snapshot block
  (the public RPC keeps no archive state, so `balanceOf` at the block cannot be read directly).
- ETH in / out, attributed to the transaction sender (`tx.from`, the wallet that signed):
  PONS curve `CurveBuy.quoteIn` (gross) minus `CurveBuyRefunded.refund`; `CurveSell.quoteOut`
  (net of curve fees); Uniswap v4 `Swap` on the PYRE pool, native ETH being currency0, so a buy
  is −amount0 and a sell is +amount0. Front-end fees an aggregator skims before the pool are not
  ETH that reached PYRE and are not counted.
- boughtUnits: PYRE that actually landed in the sender in its buy transactions (net PYRE
  Transfer delta of tx.from in each buy tx — after the v4 hook's fee, which event amounts omit).
- owedWei = max(0, min(ethIn − ethOut, ethIn × min(balance, boughtUnits) / boughtUnits)):
  the ETH still at a loss, capped at the average cost of the PYRE the address still held at
  the block. Someone who sold almost everything and kept dust is owed the cost of the dust,
  not the loss on what they sold. PYRE that only arrived by transfer was never paid for here
  and earns nothing. Only addresses with balance > 0 at the block are listed.

Logs and transactions are cached in --cache (default .tmp/pyre-refund-cache.json) so a re-run
against the same block does not refetch 20k transactions from a rate-limited RPC.
```

Totals: **785** holders with a balance at the block, **229** owed more than zero, **11.846939549841023398 ETH** owed in total.

Anyone can re-run it: it needs no keys and no database, only a Robinhood Chain RPC (`--rpc`, default the public one). `node apps/runner/scripts/load-refund-snapshot.mjs --dry-run` re-checks every row's `owedWei` against the formula and prints the totals.
