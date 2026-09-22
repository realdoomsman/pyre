# Pyre — launch from other chains and launchpads (announcement + ship day)

Display name `Pyre`, handle @PyreFun. Same rules as `posts.md`: lowercase-declarative, no emoji, no price talk, buybacks are burns never distributions, "coin" not "token", `PYRE` never `$PYRE`, "pons" and "pump.fun" lowercase, never imply a partnership with pump.fun, Robinhood or pons. Counts use X's weighting (URLs and bare domains count 23, most non-ASCII symbols count 2; `pump.fun` is a bare domain and costs 23 every time it appears).

What is true when these go out: the `multichain` branch adds Solana · pump.fun as a second venue behind the same loop. The agent still builds the app, creator fees fund it, and 25% of every fee is a buy-and-burn — of PYRE on robinhood chain, of the coin itself on solana (PYRE does not exist there). Stake is 0.05 ETH or 1 SOL, refundable. Solana on pyre is custodial only. PYRE is one coin on robinhood chain; any PYRE on another chain is not us.

Do not post either until Main confirms the staging smoke on devnet passed; post 02 only on the day mainnet is enabled (`SOLANA_RPC_URL` set in production and `/v1/venues` returning both). Never quote a fee rate as Pyre's: pump.fun sets it.

## 01 · announcement

- purpose: tease the update, in the user's words, with the two hard facts (fees burn the coin; PYRE stays put)
- day: as soon as the staging smoke passes, 15:00
- visual: none (text post). Optional: `FRESH:` a 1600×900 card in the `visuals/` style, two venue chips "robinhood chain · pons v2" and "solana · pump.fun" and one line "PYRE: robinhood chain only"
- alt text (if the card is used): two venue chips, robinhood chain with pons v2 and solana with pump.fun, and one line reading PYRE, robinhood chain only
- link: `https://pump.fun` is in the post body on purpose; first reply: https://pyre.fun
- count: 265 / 280
- note: the user's draft said "revenue burns the coin"; apps take no payments, so it is "fees burn the coin". Nothing else in the draft was changed.

```
next update: launch from other chains and launchpads — https://pump.fun included. the agent still builds the app, fees fund it, fees burn the coin. PYRE is not moving: one coin, robinhood chain, nowhere else. any PYRE on another chain is not us. coming soon.
```

## 02 · shipped

- purpose: the day it ships. the loop on solana in one breath, then the PYRE line
- day: the day `PUMP_LAUNCH_ENABLED` is live in production, 15:00
- visual: `FRESH:` the launch step-1 venue picker at 1600×900, both cards visible, "Solana · pump.fun" selected, no browser chrome
- alt text: the pyre launch page showing two venue cards, robinhood chain with pons v2 and solana with pump.fun, the solana card selected
- link: none in the post; first reply: https://pyre.fun/launch
- count: 272 / 280

```
shipped: launch on solana through pump.fun.

same loop. one sentence, a spec, a 1 SOL stake, refundable. the coin's creator fees pay the agent to build the app; 25% buys the coin and burns it, attested on chain.

PYRE stays on robinhood chain. nowhere else.
```
