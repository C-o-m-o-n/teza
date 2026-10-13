# Session log

## 2026-10-13 — initial rebuild (as TETRA//RE)

**What changed**
- Pulled `tetrio.js` out of the TETR.IO Desktop Chromium cache and extracted the gameplay constants and formulas (`docs/MECHANICS.md`).
- Wrote a deterministic TypeScript engine, a bot, a canvas renderer, synthesized SFX and a DOM UI. Modes: 40L, Blitz, Zen, VS bot (4 difficulty levels).
- 20 vitest tests: RNG, bag, gravity, lock delay, DAS/ARR, a real TSD via rotation, I-kicks, 180°, attack/B2B/combo tables, garbage timing/cap/cancel, objectives, bot survival.
- Checked in Chromium (Playwright with a fake origin mapped to `dist/`): menu, countdown, 40L play, VS garbage exchange, results, config. Fixed: Space on the results screen started an accidental rematch; garbage meter showed in non-garbage modes; VS layout clipped; keybind order.

**Still open / not done**
- Not verified: a full 40L or 2-minute Blitz run to the results screen in the browser (objectives are covered by engine tests only).
- No music. No finesse counter, replays, IRS/IHS, or online multiplayer.
- VS surge values are approximations; real league values come from the server.
- The bot is decent (~0.25 attack per piece) but not a Cold Clear-level player.

**Next steps**
- Play it yourself and tune handling feel. Add IRS/IHS, a finesse counter, replays (inputs are already deterministic per seed).
- Optional: a Tetra-League-style first-to-N match format against the bot.

## 2026-10-13 — renamed to TEZA, first commit

**What changed**
- Project renamed to **TEZA** (tetris + cheza, Swahili for "play"): package name, page title, menu wordmark (TE / ZA), README. The folder is now `~/dev/comon/teza`.
- localStorage keys changed to `teza:settings` / `teza:records`. Settings saved under the old name aren't migrated; nothing was deployed, so no players are affected.
- First commit, on branch `main`, stacked on top of the existing GitHub history (`origin/main`, the earlier Node/pnpm server version), so pushing it is a fast-forward, not a force-push. The old code stays in git history and in `~/dev/comon/teza-old`.

**Still open**
- Not pushed yet. The old version had a server (accounts, leaderboard, bot matches, pm2 `ecosystem.config.js`). This rebuild is client-only, so whatever deploys from `main` will lose those features until they are ported.
- The user accepted dropping the old server features for now. They are queued in `.factory/backlog.md` (git-excluded) as 8 items: homelab deploy, game server, accounts, online rooms, ratings/matchmaking, leaderboard/profiles, spectator, replays. Run them with `/factory next`.
- Added `npm start` (esbuild watch + serve on http://localhost:3000, `PORT` overrides it) and moved the README's Run section to use it. Tested with curl: index, game.js and style.css all returned 200.
- Benchmark (headless Node, this machine): simulating 2 minutes of one player's game takes about 24 ms of CPU, so one core can check roughly 5,000 live players. A bot decision takes about 28 ms per piece, so bots should stay in the browser.

## 2026-10-13 — hosting moved to Cloudflare Workers (factory job 001)

**What changed**
- Decided to host on Cloudflare Workers instead of the homelab self-hosted runner. Factory job `001-homelab-deploy` started as a homelab workflow, then was reworked twice and merged to local `main` (merge `87edd70`, not pushed).
- `wrangler.jsonc`: an assets-only Worker named `teza` that serves `./dist`.
- `.github/workflows/deploy.yml`: on push to `main` or manual dispatch, a GitHub-hosted runner with Node 22 runs `npm ci` and `npm run check`, deploys with `cloudflare/wrangler-action@v3` (wrangler 4.150.0), then curls `/` and `/game.js` on the deployed URL.
- `.wrangler/` added to `.gitignore`. The README Deploy section lists the secrets and token permission.
- Verified: typecheck, 20 tests and the build pass, and `wrangler deploy --dry-run` read 4 assets. No real deploy has run.

**Still open**
- Add the GitHub repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID` before pushing, or the first deploy fails.
- The post-deploy check relies on the workers.dev URL. Fill in the README `TODO:` with the live URL after the first deploy.
- Backlog item 2 still says "Node game server". It should be reworded for Durable Objects (rooms, matchmaking), D1 (players) and R2 (replays).
- `.factory/profile.md` notes are stale: they say there are no commits and the branch is `master`.

**Next steps**
- Push `main` once the secrets exist, then check the Actions run and the live URL.
- Reword backlog item 2, then `/factory next`.
