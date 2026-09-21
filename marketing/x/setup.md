# Berth — X account setup kit

Everything you need to create the account and get it verification-ready. Assets are in `marketing/x/brand/`.

## Assets to upload

| Field | File | Spec |
| --- | --- | --- |
| Profile photo | `brand/pfp.png` | 400×400, renders cleanly inside X's circle crop |
| Header / banner | `brand/banner.png` | 1500×500. Avatar overlaps the **bottom-left ~200px** — nothing critical sits there; the wordmark, loop and `berth.fun` stay clear on desktop and mobile crops |

Both are the exact product palette: ink-black `#08090b`, one green accent `#35d07f`, burn-red `#f2564d`, Silkscreen wordmark, JetBrains Mono for the loop. Same block-arrow launch mark used in the app favicon and nav.

## Handle

Pick the first that's free (check at signup):

1. **@berthfun**  ← primary
2. @berthdotfun
3. @berth_fun
4. @getberth
5. @berthlaunch

If `@berth` itself is somehow free, take it.

## Display name

- **Primary:** `Berth · coins that build apps`  (29/50 chars — searchable, states the product)
- Minimal alt: `berth`

## Bio (pick one — all ≤160)

- **A (recommended, 154):** `coins that build apps. fees fund an AI agent to ship a real app; its revenue buys back & burns the coin. ranked by dollars earned, not volume. ↑ berth.fun`
- B (149): `one sentence → a coin on pump.fun → fees pay an AI to build the app → its revenue buys back & burns the coin. real products, real revenue, not vibes.`
- C (154): `coins that build apps. fees pay an AI agent to build & ship; app revenue buys back and burns the coin. holders vote the roadmap. real revenue, not volume.`
- D (130): `a launchpad where every coin funds and owns a real app. fees build it, revenue burns it. ranked by dollars earned, not market cap.`

## Profile fields

- **Website:** `https://berth.fun`
- **Location:** `Solana` (or `on-chain`)
- **Birth/founded date on profile:** set the account's join context to now; keep it honest — Berth is newly launched.
- **Category (if using a professional/business profile):** Software / Technology.

## Getting the checkmark ("bluecheck")

Two paths — do the first now, the second when you want the gold org badge:

1. **X Premium (blue check, ~$8–16/mo).** Requirements X enforces before the badge shows:
   - Complete profile: display name + profile photo set (both provided above).
   - **Confirmed phone number** on the account (mandatory).
   - Account generally needs to be **~30 days old** and active; a brand-new account can subscribe immediately but the badge may hold for the review window. Create the account **today** so the clock starts while I prepare the launch content.
   - No recent display-name/handle/photo churn right before applying — set them once from this kit and leave them.
2. **Verified Organizations (gold check, ~$200/mo).** For the company badge and affiliate sub-accounts. Optional; do after the blue check if you want the org look.

Do first, in order:
1. Create the account with the handle + name + bio above.
2. Upload `pfp.png` and `banner.png`.
3. Add website + location.
4. Confirm a phone number and turn on 2FA.
5. Subscribe to Premium so the 30-day/verification clock is running.

## What I need from you to post on your behalf

I can prepare and stage everything (article, pinned post, video, 20 posts, reply list). To actually publish from here I need **one** of:

- **X API keys** (the platform already supports this — `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `X_BEARER_TOKEN` in `.env`; the growth worker uses them), **or**
- an **authorized browser session** to the logged-in account (I can drive posting through the relay), **or**
- you post the staged content manually — every post ships with its copy + image ready to paste.

Tell me which and I'll wire it up. Until then, all content is prepared and waiting in `marketing/x/`.
