# bingo-pokeclowns

Bingo Pokémon for a small group (~20 players): each trainer registers, gets their own 5×5 card with every phrase in a random order, and asks a moderator to validate phrases as they happen. Lines (rows, columns, diagonals) and the full card are tracked on a live leaderboard.

## Stack

| Layer    | Choice                                                                |
|----------|-----------------------------------------------------------------------|
| Hosting  | One Cloudflare Worker serving `public/` as static assets + `/api/*`   |
| Backend  | TypeScript, plain `fetch` handler with a tiny router (`src/http.ts`)  |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/`                   |
| Auth     | PBKDF2-SHA256 password hashes + HMAC-signed `HttpOnly` session cookie |
| Frontend | Vanilla JS module + Tailwind 4 (compiled), same look as `base-file.html`; fonts and confetti self-hosted (no third-party requests) |
| Updates  | Polling every 4 s against a version counter (1 row read when idle)    |
| Tests    | Vitest + `@cloudflare/vitest-pool-workers` (real Workers runtime + D1) |

```
public/          index.html, app.js, favicon.svg, _headers (CSP), img/ (victory images 1.jpg–10.jpg)
public/vendor/   fonts + confetti, copied from node_modules by `npm run build` (git-ignored)
src/index.ts     API routes
src/auth.ts      password hashing, sessions, validation
src/game.ts      card dealing, line detection, state for the client
src/http.ts      router, JSON helpers, same-origin check
migrations/      0001 schema, 0002 initial 24 phrases
test/            API tests
```

## Local development

Quick way:

```bash
make prepare   # checks Node 20+, installs missing deps, creates .dev.vars, applies pending migrations (no-op when all set)
make start     # prepare + run in the background at http://localhost:8787
make stop
make restart | make status | make logs
```

Manual way:

```bash
npm install
cp .dev.vars.example .dev.vars        # local SESSION_SECRET and INVITE_CODE
npm run db:migrate:local
npm run dev                            # http://localhost:8787
```

Make yourself moderator after registering:

```bash
npx wrangler d1 execute DB --local --command "UPDATE players SET is_admin = 1 WHERE username_lc = 'yourname'"
```

Run the checks:

```bash
npm test
npm run typecheck
```

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create bingo-pokeclowns     # paste the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET      # long random string, e.g. `openssl rand -base64 32`
npx wrangler secret put INVITE_CODE         # the code you share in Discord
npm run deploy
```

Then register in the deployed app and promote yourself with the same `UPDATE` command using `--remote` instead of `--local`.

## Game rules

- Tap a phrase when it happens → it turns **pending**. Tap again to cancel.
- The moderator approves or rejects each phrase once; it applies to everyone who marked it.
- Any full row, column or diagonal (the centre square is FREE) counts as a **line**; all 24 squares is **BINGO**.
- Leaderboard order: earliest bingo, most lines, most approved squares, earliest first line.
- 5 rerolls per player: re-deals the same phrases in a new order and resets that player's progress.
- Saving a new phrase bank (exactly 24) or "Vaciar Leaderboard" re-deals every card and resets progress; accounts are kept.

## Moderator Control tab

The 🎛 Control tab lists every trainer (lines, approved squares, pending requests, rerolls, 👑 moderator, 🔒 locked). Selecting one opens their card:

- Tap a square to approve or reject a pending request, undo an approval, or approve a square directly. Only that player's card changes; their lines and bingo are recalculated immediately.
- Account actions: make or remove a moderator, unlock after failed logins, +1 reroll or back to 5, deal a new card (rerolls unchanged), reset password, delete.
- You can't remove your own moderator role or delete yourself, so there is always at least one moderator.
- The tab refreshes only while it is open, so it adds requests for the moderator alone.

## Free tier budget (20 players)

A 3-hour game polling every 4 s uses roughly 56k of the 100k daily Worker requests, ~1.6M of the 5M daily D1 rows read, and ~15k of the 100k rows written. For longer games raise `POLL_MS` in `public/app.js`: keep it above `0.72 × game hours` seconds (with headroom, about twice that). D1 stops answering queries once a daily limit is hit, until the reset at 00:00 UTC.

## Victory images

The bingo modal shows a random `public/img/1.jpg` … `public/img/10.jpg`. They are not in the repo yet; the image frame is hidden when a file is missing.
