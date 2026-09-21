# Reply snippets

Six short replies for threads we did not start. Each is useful on its own, names Pyre only as one example, and carries no link; if someone asks for one, answer with `pyre.fun` or the repo in a follow-up. Lowercase, no emoji, no price talk. Never reply to a post that quotes a market cap or a price target with anything that could read as agreement.

Where to use them: threads on launchpad fee models, "buyback" announcements, AI-agent-built products, revenue-share coins, tokenomics diagrams, and "is anything actually getting built" complaints.

## 1 · a launchpad thread asks where creator fees go

```
worth asking every launchpad the same three questions: what share of the trade fee reaches the creator, who is the creator wallet, and what is the money contractually for. on pyre it is 70% of a 1% fee, the app's own wallet, and 60% of it is a build budget. the answers matter more than the apy.
```

## 2 · someone announces a "buyback" with no receipts

```
a buyback is only a claim until three things are public: the swap tx, the burn tx (totalSupply should drop, not a transfer to a dead wallet), and something that ties the burn to the revenue that paid for it. pyre does the third with a hash of the revenue event ids in a zero-value tx. cheap to do. hard to fake.
```

## 3 · a thread on ai agents shipping code to production

```
the model finishing is not the gate. the gate is: does it build, do the smoke tests pass, what does lighthouse say, and does a second model agree the diff matches the spec. pyre also runs a mechanical pass first: raw fetch, eval, private keys, wallet calls in app code fail the deploy before anyone reads it.
```

## 4 · "revenue share" coins and holder rewards

```
if revenue is paid to holders it is a distribution, with everything that word brings. if revenue buys the coin on the open market and burns it, nothing is paid to anyone; supply just falls. those are different products with different obligations. pyre chose the second on purpose, and the terms say so.
```

## 5 · "nothing on launchpads ever gets built"

```
mostly true, because launching is the whole product. the fix is to make the coin fund something with a spec, a budget and a build gate, and to rank by what the thing earned instead of what traded. that is the entire bet behind pyre. still early, but the mechanism is the point, not the ticker.
```

## 6 · a security thread on custodial wallets for agent-built apps

```
the line we found that matters: the agent never writes auth, wallet or payment code. those are platform-hosted and reached through an sdk; generated apps run under a csp with no outbound network and server functions in a 64 mb, 5 s sandbox. a prompted app that cannot reach a key cannot drain one.
```

## rules

- Reply within the first hour of a thread or not at all; late replies read as promotion.
- One reply per thread. Do not reply to replies unless asked a direct question.
- If asked "when PYRE": `launching soon. no contract address exists yet; anything posted before we do is not us.`
- If asked for numbers: quote only what is on pyre.fun/burns or in the repo. Until the first real launch the honest number is zero: no apps, no burns. Say so; never quote a figure from a screenshot or a demo.
- Never argue about price, never compare to another launchpad by name, never say "partner" about pons or robinhood.
