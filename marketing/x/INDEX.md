# Berth — X launch kit

Everything to launch @berth on X. **Start with `setup.md`** — create the account with the pfp/banner/bio while the rest is ready to post.

## What's here

| File | What it is |
| --- | --- |
| `setup.md` | Handle, display name, bio options, verification steps, and what I need to post for you |
| `brand/pfp.png` | Profile photo, 400×400 |
| `brand/banner.png` | Header, 1500×500 |
| `article/article.md` | The long-form X **Article** (paste into X Articles; figures are the `image:` files noted inline) |
| `pinned.md` | The pinned post that quote-tweets the Article + attaches the video |
| `video/berth-launch.mp4` | 1920×1080, 39.7s, H.264+AAC, ~13 MB. Kinetic titles + real product motion + on-brand chiptune. No voiceover, nothing AI-generated. |
| `posts.md` | 20 standalone posts, each with its image filename + char count |
| `replies.md` | 8 reply templates + 15 archetype targets (search terms, no fabricated handles) + engagement rules |
| `posts/*.png` | Designed post cards (1600×900) |
| `cap/*.png`, `cap/el/*.png` | Real product-UI captures used as post/article images |

## Launch order

1. Create the account from `setup.md`; upload pfp + banner; set bio/link; confirm phone; subscribe to Premium (starts the verification clock).
2. Publish the **Article** (`article/article.md`).
3. Post the **pinned** tweet (`pinned.md`) quoting the Article, with `video/berth-launch.mp4` attached; pin it.
4. Post the **20 posts** (`posts.md`) — space them out; each has its image.
5. Work the **reply playbook** (`replies.md`).

## Two things to know

- **Representative data.** The product is newly launched and the live board is empty, so the UI screenshots/video use *representative* sample data to show the interface — they are **not** claims of revenue already earned. The Article says this explicitly. Everything about the *mechanism* and the *engineering* (211 tests, 31/0 security, 0 drift, real pipeline in prod) is true and grounded in the repo.
- **Posting on your behalf needs credentials.** To publish from here I need X API keys (`X_API_*`, already supported by the growth worker) **or** an authorized browser session, **or** you post manually. See `setup.md`.

## Bonus finding (repo)

`apps/web/public/og.png` still reads **"SHIP / ship.fun"** — stale from before the Berth rename. The live share card component (`ShareCard.tsx`) is already "berth". Regenerate `og.png` before wider sharing. (The generators in `posts/src` and `video/src` can produce an on-brand replacement.)

## How the assets were generated (reproducible)

- `brand/src/*` — pfp/banner HTML + the pixel mark
- `posts/src/cards.html` — the designed-card factory (`?c=<name>`)
- `cap/fixtures.mjs` — representative API fixtures used to populate the real SPA for captures
- `video/src/` — `kinetic.*` (motion-graphics engine), `music.mjs` (chiptune synth), `render_kinetic.mjs` (frame renderer)
- `serve.mjs` — local static server used during rendering
