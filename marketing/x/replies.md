# Berth — X reply playbook

Reusable replies, targeting archetypes, and engagement rules. Lead with the mechanism. No emojis, no hashtags, no price talk, no promised returns. Each template is <=280 characters.

## (a) Reply templates

### 1. "how is this different from other AI-coin launchpads"
```
most launchpads stop at the coin. here the coin is the funding: 60% of trading fees pay an agent to build a real app, and the front page ranks by dollars the app earned, not volume. the coin exists to fund and own software.
```

### 2. "is this a security / do holders get paid"
```
holders are never paid. no dividend, no yield, no revenue share. app revenue buys the coin back on the open market and burns it, so supply falls but nothing is distributed. $BERTH has two one-way sinks: burn and staking. that's the whole design.
```

### 3. "what stops the AI from rugging / writing malware"
```
the agent never writes auth, wallet or payment code; those are platform-hosted behind an SDK. generated apps run under a strict CSP with no outbound network, server logic runs in a QuickJS sandbox, a reviewer agent gates every deploy, and all source is public and MIT.
```

### 4. "how do I know the revenue is real"
```
every burn's memo carries a sha256 of the exact revenue-event ids it settles, so payment -> burn is reproducible on-chain by anyone. the platform is merchant of record and each revenue event is verified before it drives a buyback. it's a receipt, not a claim.
```

### 5. "what happens when the budget runs out"
```
the app goes behind a buy-to-revive page but keeps serving traffic and earning. only the build loop pauses. any new fee, or a direct top-up, restarts it. dormant, not dead.
```

### 6. "is the code open"
```
yes. every generated app is public and MIT. the launcher assigns no IP and gets no equity and no supply. the build streams live to the coin page while it happens, so you can read exactly what shipped.
```

### 7. "how much does it cost to launch"
```
a refundable 0.05 SOL stake. it's spam control and pays the token-creation transaction, and you get it back the moment your coin funds its first build. a failed launch refunds immediately.
```

### 8. "does it actually work yet"
```
the pipeline runs in production end to end: sandbox boots, npm run build and a Playwright smoke pass, screenshots, a Lighthouse audit, then the reviewer gate. 211 tests pass with no network, security perimeter 31/0, 0 ledger drift. builds are pre-revenue, gated on credits.
```

## (b) Archetype targets

No fabricated handles or follower counts. Find each archetype with the search term, then reply with the angle given. Always lead with the mechanism; disclose pre-revenue where relevant.

1. **pump.fun launchers/traders**
   - search: `pump.fun launch` / `pumpfun new coin`
   - say: most coins here have no product; a Berth coin funds and owns one, and the board ranks by dollars earned, not volume.

2. **Solana builder/dev accounts**
   - search: `solana dev` / `building on solana`
   - say: point at the perimeter (SDK-only auth/payments, strict CSP, QuickJS sandbox, reviewer gate) and that all app code is MIT.

3. **AI-agent / autonomous-agent enthusiasts**
   - search: `ai agents` / `autonomous agents crypto`
   - say: an agent designs, builds, deploys and iterates a real app, gated by build + smoke + Lighthouse + reviewer before deploy.

4. **Claude / Anthropic dev community**
   - search: `claude agent sdk` / `claude code build`
   - say: the build runs the Claude Agent SDK in an E2B microVM against a fixed template with hard verification gates.

5. **x402 / agent-payments crowd**
   - search: `x402` / `agent payments usdc`
   - say: apps charge via x402 per-call, USDC checkout, ad slot or holder tier; revenue is verified, then 85% burns the coin.

6. **DeFi tokenomics skeptics**
   - search: `tokenomics` / `is this a security`
   - say: nothing is paid to holders; buybacks are burns with on-chain sha256 attestation, two one-way sinks, no distribution.

7. **rug-pull / scam-watch accounts**
   - search: `solana rug` / `crypto scam warning`
   - say: the agent can't write wallet/payment code, no outbound network, reviewer gates every deploy, source is public.

8. **open-source / MIT advocates**
   - search: `open source mit` / `open source crypto`
   - say: every generated app is public and MIT; launchers assign no IP and receive no equity or supply.

9. **indie hackers / "build in public"**
   - search: `build in public` / `indie hacker saas`
   - say: describe one sentence -> spec -> live app that charges users; the whole build streams live and is public.

10. **on-chain analytics / data accounts**
    - search: `onchain data solana` / `solana analytics`
    - say: payment -> burn is reproducible from the memo sha256; the public ledger and stats endpoints expose the movements.

11. **Solana ecosystem / news aggregators**
    - search: `solana ecosystem` / `solana news`
    - say: a launchpad ranking coins by product revenue, with a build pipeline verified running in production.

12. **crypto governance / DAO community**
    - search: `token governance` / `dao voting`
    - say: holders steer the roadmap via a token-weighted prompt queue with a per-wallet cap, so no wallet owns direction.

13. **AI x crypto researchers / writers**
    - search: `ai crypto` / `agentic commerce`
    - say: a closed loop where fees fund compute end to end (per-coin credits slice pays the model bill) and revenue burns supply.

14. **QuickJS / sandbox / websec people**
    - search: `sandbox security` / `csp web security`
    - say: server logic runs in a QuickJS sandbox (64MB, 5s), strict CSP, no outbound network, per-job budget-capped tokens.

15. **Solana wallet / consumer-app users**
    - search: `solana wallet app` / `solana consumer app`
    - say: apps are real products with USDC checkout; you can watch them get built and read the MIT source.

## (c) Engagement rules

1. **No spam.** One relevant reply per thread; no copy-paste blasts, no repeating the same template across a timeline. Tailor to what the post actually said.
2. **No price talk.** Never mention targets, multiples, market cap or "when moon." Talk about mechanism, code, and verifiable receipts only.
3. **Lead with the mechanism.** Open with the concrete fact (the split, the sandbox, the attestation), not adjectives or a call to buy.
4. **Disclose pre-revenue where relevant.** The pipeline is verified in production but builds are gated on Anthropic credits; say "pre-revenue" or "gated on credits" when the claim implies live earnings.
5. **Never promise returns.** Burns are supply reduction, not payouts. State plainly that holders are never paid a distribution.
