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

## 2026-10-13 — Workers game server (factory job 002)

**What changed**
- `wrangler.jsonc` now has a script (`main: worker/index.ts`) next to the `dist/` assets. `run_worker_first: ["/api/*"]` keeps every other path on the static asset handler.
- `GET /api/match/<id>` (WebSocket) routes to one `Match` Durable Object per id (sqlite-backed class, migration `v1`). Bad ids get 400, non-upgrade requests 426, other `/api/*` 404.
- `src/server/match.ts` holds the match logic with no Cloudflare imports: Ribbon envelopes `{t,s,a,d}`, a 100-packet resend buffer per slot, input validation (frame order, 30-frame clock tolerance, 60 inputs/s, 1 KB message cap), garbage transfer, top-out and 15 s disconnect forfeit. No tick; engines advance as inputs arrive. Match rules are the client's VS preset (`modeById("vs")`).
- `test/match.test.ts` (13 tests) drives it with a fake clock and fake sockets.
- `@cloudflare/workers-types` added; `npm run typecheck` also runs `tsc -p worker`. `dist/` output is byte-identical to before.
- Deploy workflow curl checks now use `--retry 10 --retry-delay 6 --retry-all-errors`, since a fresh workers.dev URL 404s for a short while.

**Still open**
- `npx wrangler dev` was not started (needs your OK); routing was checked by running the bundled worker's `fetch` in Node with a stub Durable Object. Worth one `wrangler dev` check before the first real deploy.
- No client yet: the browser has no online mode, lobby or WebSocket client.
- Match state lives in memory only. If the Durable Object is evicted (for example, both sockets gone for a while), the match is lost.
- The first deploy with this config creates the `Match` Durable Object class (migration `v1`). Not tried against the real account; if it fails, check the API token's permissions first.

**Next steps**
- Run `npx wrangler dev` once and curl `/`, `/api/match/abc`, `/api/match/bad%20id` and `/api/nope`.
- Next backlog item: online rooms (client WebSocket using the same envelope).

## 2026-10-13 — Game server hardening (factory job 002, rework 1)

**What changed**
- `src/server/match.ts`: a player can no longer stall a match. Inputs more than 120 frames behind the server clock are rejected (`frame-late`), and on every incoming message any engine more than 120 frames behind is advanced to that limit on a whole frame, so a silent player keeps falling and tops out. Still no tick or interval.
- Idle sockets are bounded: sockets waiting to `resume` must do so within 5 s and at most 2 may wait at once (`busy`); a match with no second player after 2 minutes is reset (`no-opponent`); after `end` both sockets are closed and new ones get `ended`.
- `test/match.test.ts` has 6 new tests for these rules (19 in the file). The fake clock no longer fires a timer that an earlier timer cleared in the same step.

**Still open**
- Same as the entry above: `npx wrangler dev` has not been run, no client yet.
- A Cloudflare rate-limiting rule on `/api/match/*` would still help against many match ids being opened at once; that is dashboard config, not code.
- The 120-frame lag limit and 5 s / 2-minute timeouts are first guesses; tune them once a real client exists.

**Next steps**
- Run `npx wrangler dev` once and curl `/`, `/api/match/abc`, `/api/match/bad%20id` and `/api/nope`.

## 2026-10-13 — Custom domain and reconnect/idle fixes (factory job 002, rework 2)

**What changed**
- `wrangler.jsonc`: the Worker is served on the custom domain `teza.comonhq.com` (`custom_domain: true`) and `workers_dev` is off, so the zone's rate-limit rule can't be skipped via workers.dev.
- `.github/workflows/deploy.yml`: the post-deploy check no longer uses wrangler-action's `deployment-url`. It curls a fixed `SITE_URL` (`https://teza.comonhq.com`) for `/` and `/game.js`, and requires `/api/match/ci-check` without an upgrade header to return 426.
- Reconnect can't be blocked: a returning player puts `?resume=<token>&ack=<peerAck>` on the upgrade URL. The Durable Object checks it before accepting (400 malformed, 403 unknown token) and the socket takes its slot without waiting among the pending sockets.
- Idle deadline: if neither player sends a valid message for 60 s after `start`, both engines run to the clock (a top-out decides it) or the match ends as a draw (`end {winner: null, reason: "idle"}`). Catch-up now moves lagging engines together frame by frame, so whoever tops out first loses.
- README: live URL is https://teza.comonhq.com/; documents the zone rate-limit rule and same-origin API calls.

**Still open**
- The DNS/custom-domain setup and the rate-limit rule (comonhq.com zone, hostname `teza.comonhq.com`, path `/api/match/*`, per IP, block) are dashboard config; confirm both exist before the next deploy. The API token may also need zone permissions for the custom domain route.
- `npx wrangler dev` has still not been run; no client yet.

**Next steps**
- After the next deploy, confirm the CI check passes against https://teza.comonhq.com.

## 2026-10-13 — Player accounts (factory job 003, build round 1)

**What changed**
- New `Accounts` Durable Object (one global instance, SQLite, migration `v2`, binding `ACCOUNTS`) serving `/api/account/register|login|logout|me|records`. Logic in `src/server/accounts.ts`, tested with an in-memory store in `test/accounts.test.ts`.
- Passwords: PBKDF2-SHA-256, 16-byte salt, 100000 iterations, constant-time compare. Sessions: 32-byte token in an HttpOnly/Secure/SameSite=Strict cookie on `/api`, 30 days, only its SHA-256 stored. Cross-origin POST/PUT get 403.
- `src/profile.ts` now holds `Records`/`RunRecord` (re-exported from `src/settings.ts`), the records validator and the better-wins merge, shared by client and server.
- Client: SIGN IN entry and signed-in panel (username, 40L PB, Blitz PB, bot W–L, SIGN OUT) on the main menu, an ACCOUNT screen with sign-in/register tabs and inline errors, and records sync on start and after every run.
- The Worker reads account request bodies (max 4 KB) itself and forwards them buffered: streaming them on to the Durable Object broke the connection whenever it answered early (403/415), which reset the object.

**Still open**
- No rate-limit rule yet for `/api/account/*`; add one in the comonhq.com zone dashboard (login and register, per IP) before relying on accounts.
- Under `wrangler dev`, refusing an oversized chunked upload makes wrangler's local proxy drop its connection once; a POST sent right after can fail with 500. Not seen with a Content-Length body; production untested.

**Next steps**
- After deploy, register a test account on https://teza.comonhq.com and check that records sync between two browsers.

## 2026-10-14 — Player accounts (factory job 003, rework 1)

**What changed**
- SIGN OUT now sends a last records `PUT`, signs out, then clears the local records, so the next player on a shared device doesn't inherit (or merge into their own account) the previous player's bests.
- Account screen: the submit button reads LOG IN → / CREATE ACCOUNT → so it no longer repeats the SIGN IN tab label, and the tabs carry `aria-pressed`. Inputs show a 2px blue focus outline.
- Under 860 px the account block sits between the brand and the mode bars, so SIGN IN is visible without scrolling.

**Still open**
- Same as round 1: no rate-limit rule for `/api/account/*` yet.
- On narrow screens ↑/↓ still walks the menu in DOM order (bars first, then SIGN IN), which no longer matches the visual order.

## 2026-10-14 — Player accounts (factory job 003, rework 2)

**What changed**
- SIGN OUT only signs out when the records `PUT` and then the logout both answer 2xx. Otherwise the player stays signed in, keeps their local records, and the account block shows "Couldn't sign out — check your connection" with SIGN OUT enabled again. Before, a failed logout cleared the UI and records while the server session stayed valid.
- Every account request is aborted after 8 s (`REQUEST_TIMEOUT_MS` in `src/ui/account.ts`), so SIGN OUT can't stay disabled on a hanging network.
- `test/account-client.test.ts` covers the upload-failure, logout-failure and timeout paths with a stubbed `fetch`.

**Still open**
- Same as before: no rate-limit rule for `/api/account/*` yet; ↑/↓ order on narrow screens.

## 2026-10-14 — Player accounts (factory job 003, rework 3)

**What changed**
- SIGN OUT treats a 401 from the records `PUT` or the logout as already signed out: it clears the account and the local records instead of showing an error. After a 401 on the `PUT`, logout is skipped and that last upload is lost (the server keeps every earlier one). Network errors, timeouts and other non-2xx still keep the player signed in with the inline error.
- The button reads SIGNING OUT… while it waits.
- `test/account-client.test.ts` covers both 401 paths.
- README: the Cloudflare zone rate-limit rule now covers all of `/api/*` on teza.comonhq.com (the user widened it in the dashboard), so login and register are rate-limited.

**Still open**
- ↑/↓ order on narrow screens still follows DOM order (bars first, then SIGN IN).

## 2026-10-14 — Browser e2e runs (factory job 005)

**What changed**
- Closes the 2026-10-13 gap "Not verified: a full 40L or 2-minute Blitz run to the results screen in the browser". `npm run e2e` (Playwright, Chromium) builds `dist/` and plays a full 40 LINES run to `40 LINES CLEARED` (LINES 40) and a full 2-minute BLITZ run to `TIME'S UP`, whose score must equal a Node replay of the same inputs.
- `?seed=<positive integer>` in the URL fixes the session seed; without it the seed is random as before.
- Inputs come from the game's own bot, planned in Node on the same timeline the browser sees under Playwright's fake clock (`e2e/plan.ts`).

**Still open**
- e2e is not in `npm run check` or CI (needs a browser install there).

## 2026-10-14 — Board physics and Reduce motion (factory job 006)

**What changed**
- Hard drop stretches the board up and then squashes it, about the board bottom, on its own spring.
- Each cleared cell breaks into 1, 4 or 9 shards, depending on bounciness. The shards keep the cell's colour, fly out, spin, fall and fade. They replace the old confetti; the white flash stays.
- Spin and B2B clears send a white ring outward from the cleared rows.
- When danger is above 0.5 the board pulses in a lub-dub every 1.2 s.
- Incoming garbage (`garbage-in`) knocks the board sideways, alternating left and right.
- Every new effect scales with bounciness and is off at 0%.
- New CONFIG › AUDIO & VISUAL toggle: Reduce motion (`reduceMotion` in `teza:settings`). It and the OS `prefers-reduced-motion` setting both turn off every board movement, including the old spring kicks. Changes to the OS setting apply live. Flash, action text and the danger colour stay.
- `test/board-view.test.ts` covers the BoardView logic without a canvas.

**Still open**
- Nothing known.

## 2026-10-14 — Procedural music and sound packs (factory job 007)

**What changed**
- Generative session music (`src/audio/music.ts`), all Web Audio with no audio files. A look-ahead scheduler plays a looping chord progression in the pack's key. The pad always plays. Bass and kick come in at danger 0.15, arpeggio and hats at 0.4, a tension lead at 0.7. Tempo eases from 100 to 150 BPM with danger, and BLITZ adds up to ×1.25 over its last 30 s.
- Combos (from 1 COMBO) add a melody phrase that starts on the next 16th note. Every player clear ducks the music for about 350 ms.
- Audio mixer: separate music and SFX buses. CONFIG › AUDIO & VISUAL has new **Music** and **Sound pack** controls (Arcade / Glass / Neon), saved as `musicVolume` and `soundPack` in `teza:settings`.
- The player's piece sounds are panned by column. Spin and B2B have new layered patches.
- Music starts with the countdown and fades on top-out, finish or K.O. Leaving for the menu stops the scheduler, and retry restarts it.

**Round 2 (design review)**
- The music now follows an intensity value: the strongest of danger, stack height, the running combo and BLITZ's last 30 s. Before, danger alone was 0 below a ~15-row stack, so normal play heard only the pad.
- Bass and kick start at a 4-row stack, arpeggio and hats at 10 rows. In BLITZ's last 30 s the arpeggio comes in, and the tempo rises to 187.5 BPM at time-up.
- The pad has a soft pulse on every beat. Layers have a 0.05 drop-out margin. The pack select shows a focus outline for keyboard users.

**Round 3 (rework after listening)**
- Songs are now data (`src/audio/songs.ts`). There are five original songs, each with its own key, chord loop, groove and tempo: Lantern (menus), Gridline (40 LINES), Afterburn (BLITZ), Undertow (VERSUS) and Tidepool (ZEN, which has no danger gear). Packs now set only the timbre.
- The music moves in stepped gears (calm, groove, drive, danger). Each gear has its own tempo and arrangement. A gear change lands on the beat with a crash going up or a sweep going down, and there is a 0.08 hysteresis margin. Incoming garbage counts toward VERSUS intensity.
- Menu music: Lantern plays in the menus, crossfades into the mode's song at the countdown, and crossfades back when the run ends. New CONFIG **Music track** setting: Auto, a fixed song, or Off (`musicTrack`).
- Punchier mix: a pitch-dropping kick with a click, a plucked bass with a sub, a snare, kick sidechain, and light saturation plus a compressor on the music only. Default music volume is now 60%. SFX have faster attacks, a heavier hard-drop thump and bigger clears that scale with lines, and their chords follow the song's key.

**Still open**
- `npm run e2e` BLITZ takes about 2.2 min of real time (1.4 min on main). The menu and session music create voices under the fake clock.
- A browser that saved settings from an earlier build of this branch keeps its saved music volume (40%), not the new 60% default.
- Judged by measurement only. The sandbox has no audio output, so nobody has listened to the mix yet.

## 2026-10-14 — Finesse counter and IRS/IHS (factory job 008)

**What changed**
- IRS and IHS (`handling.irs`, `handling.ihs`, both on by default; toggles in CONFIG › HANDLING). With no spawn delay, they act on rotate/hold keys held when a piece spawns after a lock: IHS holds once, then IRS rotates the new piece with the most recently pressed rotate key still held. Neither counts as an input.
- Finesse faults: the player's game counts left/right/rotate presses per piece and adds the excess over an empty-board BFS minimum (`src/engine/finesse.ts`) at each lock. Shown live as FINESSE in 40 LINES and on every results screen.
- The match server replays inputs with an explicit `MATCH_HANDLING` and sends it in `start`, so an online client can apply IRS/IHS exactly as the server does.

**Still open**
- There is no online client yet. When one is written it must build its Game with `start.handling`, and send releases for held keys when it calls `releaseAll` on blur.

## 2026-10-17 — PB ghost for 40 LINES (factory job 009)

**What changed**
- `src/engine/replay.ts`: a 40L replay is `{seed, handling, frames, events}`, where each event is a press, release or releaseAll with the game frame it landed on. `Recorder` applies and records inputs. `ReplayPlayer` rebuilds the run on a fresh 40L game with the saved seed and handling. `parseReplay` accepts a stored replay only when it has a valid shape and its `frames` equals the PB.
- A 40L clear that sets a new PB saves its replay to `localStorage["teza:ghost40l"]`. It is not in `Records` and does not go to the server. The next 40L run shows a translucent PB GHOST board to the right of the player, in lockstep from GO, with a `GHOST +n` / `YOU +n` / `EVEN` lines marker. It freezes at 40 lines.
- Exactness: `Game.advance` resolves lock delay, gravity and DAS at the end of each step, so a run depends on where it stopped. The 40L player now rests only on whole frames between inputs, and inputs land on a 1/256-frame grid (`restFrame`), so a replay takes the same steps. Without this, 40 of 40 probe runs diverged on replay. The e2e planner mirrors the new stepping, and the 40L e2e replays the browser's stored replay in Node.

**Still open**
- Between inputs the 40L display trails the clock by under one frame.
- A PB merged from the account server on sign-in has no replay, so it shows no ghost until a faster local clear.
- The match server (`src/server/match.ts`) steps a game straight to each input frame, so a future online client must step the same way (whole frames between inputs, inputs on a fixed grid) or the boards can drift. Worth a backlog item.

**Round 2 (design review)**
- The ghost marker now sits above the ghost's three spawn rows, so the falling piece no longer covers it.
- In windows too narrow for a ghost cell of at least 8 px (e.g. 390 wide), the ghost is not drawn, instead of showing a clipped sliver.
- The ghost no longer draws its clear names, which overlapped its stats at 1440x900.

## 2026-10-17 — Brand identity, "Poster Slab" (factory job 010)

**What changed**
- New identity (direction A, picked at the user's request): ink `#0B0B0C`, paper `#F3EFE6`, signal red `#E0301E`, field green `#0F6B3E`; Big Shoulders Display and Archivo Narrow, self-hosted (variable latin woff2 plus OFL texts). Russo One and Saira stay for the canvas HUD.
- `src/ui/brand.ts` `wordmark()`: TEZA with the Z drawn in SVG as a heavy Z cut into four Z-tetromino-like pieces. It appears on the title, the menu slab and the ACCOUNT, VERSUS and CONFIG headers.
- Menu: a red slab (40%) holds the wordmark set bottom to top and cropped, then a 12px green stripe, then the mode bars as bands on ink, separated by thick paper rules and stepping in two grid columns per row. At 860px and below the slab becomes a top band.
- Title screen (once per load, and again by clicking the menu's wordmark): T, E, Z, A drop over their ghost outlines and lock with a one-frame squash, the CHEZA row clears, and the screen wipes off to the menu underneath (about 4 s). Any key or click skips it. With reduced motion (OS or CONFIG) it shows the last frame with no animations and waits for input.
- Icons, `icons/favicon.svg` and `og/og-image.png` come from `npm run brand` (`scripts/brand.mjs`, Playwright screenshots). Open Graph/Twitter tags point at https://teza.comonhq.com/. No domain appears in visible copy; the footer line is "built in kenya".
- The e2e now waits for the title and presses Space to reach the menu.

**Still open**
- The domain for visible copy is undecided (the v1.0.0 line said `teza.ke`). Only the OG URLs name one.
- The title's auto-advance uses CSS animation time, which Playwright's fake clock doesn't control; the e2e skips the title with a key instead.

**Round 2 (design review)**
- CONFIG opens scrolled to the top, so its red header is fully in view (focusing BACK used to scroll it off). A rebind redraws the screen at the scroll position it had. The header band is smaller.
- Arrow key caps are drawn as SVG block arrows. The brand fonts have no ← or →, and their ↑ ↓ are hairlines. Key-cap text is 16px.
- The title's "press any key" is paper at 70%, not muted grey. At 390 the small wordmark has more room above the VERSUS and ACCOUNT titles.

## 2026-10-17 — Interface themes, Classic and Poster Slab (factory job 011)

**What changed**
- New setting `theme` (CONFIG › STYLE › Interface theme), from the registry in `src/ui/themes.ts`: **Classic** (the default, also for saved settings without a theme) and **Poster Slab**. An unknown id falls back to Classic. RESET TO DEFAULTS returns to Classic. Switching redraws CONFIG in place and never starts the title screen.
- Classic is the UI from before job 010: dark background, stacked TE over ZA with the signed-in stats under it, coloured stepped mode bars, text arrow key caps, no title screen. Poster Slab is job 010's UI, title screen included.
- `<html data-theme>` and the `theme-color` meta are set by an inline script in `index.html` before the stylesheet, so the first paint is already themed. `style.css` scopes each theme's rules with `:where(...)`, so specificity is unchanged and Classic applies when the attribute is missing or unknown.
- Classic wordmark: the original heading with the Z drawn as the cut Z, in the original blue `#3F6BFF`, stretched to Russo One's Z so A doesn't move. Each time the menu opens, its four pieces drop in and lock, bottom row first (0.6 s). There is no drop with reduced motion, or when the menu only redraws (sign-in or sign-out).
- Icons, favicon and the share image are now Classic's: blue Z-tetromino cells with a white accent on `#08080F`, and a dark OG image with the stacked wordmark. The manifest colours are `#08080F` again.
- e2e: the 40 LINES and BLITZ runs play in both themes, and `e2e/themes.e2e.ts` covers the pre-paint theme, each theme's first screen, the CONFIG switch with reload and reset, and the Z drop with and without reduced motion.
- Checked by screenshot diff against `b650320` (5faf0c9 plus the PB ghost) for Classic and `86ee106` for Poster Slab, at 1280x800 and 390x844. Menu signed out and in, VERSUS, ACCOUNT, CONFIG and results all matched with 0 differing pixels, apart from the Z box and CONFIG's added STYLE panel. The game canvas was hidden for the diff because its background differs between two loads of the same build.

**Still open**
- The inline pre-paint script lists the theme ids and colours again. `test/themes.test.ts` fails if it drifts from the registry.
- If the sign-in check answers while the Z is still dropping, the redraw snaps the pieces into place.

**Round 2 (design review)**
- CONFIG's STYLE panel is now a row of its own above HANDLING, AUDIO & VISUAL and CONTROLS, one column wide on the same grid. Those three panels lay out as before in both themes, with no hole under STYLE in Poster Slab at 1440. Screenshot diffs with the strip removed show 0 differing pixels against the pre-010 build (Classic) and main (Poster Slab) at 1280x800 and 390x844.
- In Classic's drop, TE stays in front of the falling Z pieces.

## 2026-10-17 — Deterministic stepping everywhere (factory job 012)

**What changed**
- `src/engine/stepping.ts` holds the canonical stepping that used to live in `replay.ts`: `restFrame` (whole frame between inputs, 1/256-frame grid at an input), `stepTo` and `stepToClock` (rest on the whole frame before the clock, then for an input on its grid point).
- `App.advanceTo` keeps the session clock in every mode and steps the player and the VS bot with `stepToClock`; no raw fractional `advance` is left. 40 LINES recording and the ghost are unchanged.
- `src/server/match.ts`: an accepted input lands on its frame floored to the 1/256 grid, and `opponentInput` carries that frame. `catchUp` uses `stepTo`. Rejection rules and limits are unchanged.
- `e2e/plan.ts` and the mirror in `test/replay.test.ts` use the shared functions. The match test harness moved to `test/match-harness.ts`; `test/stepping.test.ts` checks that a client stepped like App and the server reach the same game.
- Replays recorded on main (two in Chromium, two in Node) replay to byte-identical states on this branch.
- BLITZ seed 7 in the e2e now scores 210376 (was 210372) and ends on frame 7200 (was 7201): the player now rests on whole frames instead of the 16 ms tick ends, so at placement 218 the bot saw a slightly different piece position and chose a different placement; and the old fractional sums drifted (frames like 4187.039999999999), which made the timed objective trip a frame late. Browser and Node agree, and the e2e has no hard-coded score.

**Still open**
- No online client exists yet; one must step with `stepToClock` and send the grid frame for its inputs.

## 2026-10-17 — Online 1v1 rooms with client-side prediction (factory job 013)

**What changed**
- Server: `opponentInput.frame` is now the frame the server's engine applied the input at (job 012's security note); it equals the snapped frame unless the engine was already past it. New `opponentGarbage {amount, frame}` goes to the attacker with every `garbage`. `MatchSession.hasPlayers` lets the Durable Object refuse `create` on a held room (409) and `join` on an empty one (404).
- Worker: `POST /api/room` issues 6-symbol room codes (`newRoomCode`, `ROOM_CODE` in `src/server/match.ts`); the match route takes only codes (400 otherwise) and new sockets must say `?mode=create` or `?mode=join`. The deploy check probes `/api/match/CHECK2`, since `ci-check` is no longer a valid code.
- Client: `src/net/online.ts` holds the protocol and prediction (own board predicted, rewound on server garbage from snapshots plus an input log ordered by the envelope ack; opponent board stepped only from the relay). `test/online.test.ts` drives two clients through `MatchSession` over a simulated network with different latencies and checks both boards against the server's engines, also with a non-default `MATCH_HANDLING`.
- UI: VERSUS has CREATE ROOM and JOIN ROOM bars (the six bars use a denser stack so they fit 1280x720 in both themes), an ONLINE lobby with the code, a JOIN field, the online match on the bot game's two-board layout, and online results with one MENU action. Board markers are now drawn on regular views too (they were drawn only on the 40 LINES ghost); the online match uses them for `OPPONENT DISCONNECTED · 12s` and `TOPPED OUT · WAITING`.
- Checked with `wrangler dev --local-upstream` and two headless Chromium pages: create, join, a top-out giving WIN and LOSE, garbage from a Node client's line clears landing on the browser's board, closing a tab giving OPPONENT DISCONNECTED then a win after 15 s, `No such room` and `Room is full`.

**Still open**
- No auto-reconnect or resume UI; a dropped socket ends the session as CONNECTION LOST.
- The opponent's board rests at the last relayed frame, so between their inputs it doesn't fall.
- A player more than 2 s behind the server clock has inputs rejected as `frame-late` that their client already applied, so the predicted board drifts from the server until the match ends; only garbage is rewound. (The catch-up target equals the frame-late bound, so a catch-up alone never moves an engine past an accepted input's snapped frame; the relay test moves the engine directly.)
- Hardening still to do: Origin check on the upgrade, resume token out of the URL, constant-time token compare, CSP.

## 2026-10-17 — Online rooms, round 2: input pacing under jitter (factory job 013)

**What changed**
- The server meters inputs with a token bucket per player (`INPUT_BURST` 90, refilled at `MAX_INPUTS_PER_SECOND` 60) instead of 60 in any second. The client paces with the same rate and a burst of `PACE_BURST` 30, so packets jitter bunches together still fit for up to 1 s of jitter (`JITTER_MS`; the reasoning is at the top of `src/net/online.ts`). Before, the client sent 60 per 1.1 s by send time and the server counted 60 per 1 s by arrival, so about 100 ms of jitter at the cap could get an applied input refused.
- A refused input's `error` now carries its `s`. The client takes that input back out of its predicted board by rewinding and replaying without it (the garbage rewind is now a shared `replay`); a refused press stops counting as held, and a refused release is sent again. This also covers the `frame-late` drift noted in the previous entry.
- `test/online.test.ts`: two clients at the cap with 900 ms uplink stalls (no refusals, boards equal), and a 1250 ms stall that gets inputs refused (both kinds rolled back, boards equal). With the rollback disabled the second test's boards differ; with a 60/60 bucket the first gets refused and dropped.
- README: room codes are generated by the server on request, but a client can open any well-formed code.

**Still open**
- More than 20 refused messages still close the socket (`MAX_REJECTED`, per socket, never reset); a connection with more than 1 s of jitter many times over could hit it.
- Sounds and predicted attack flights of a refused input have already played; only the board is taken back.

## 2026-10-18 — Ratings and ranked matchmaking (factory job 014)

**What changed**
- `src/server/rating.ts`: Glicko-2 and the TR formula ported from v1 with its constants; `tdisplay` hides TR while RD > 100. The volatility iteration keeps `a = ln(σ²)` fixed as in Glickman's paper (v1's closure read the moving bracket end `A`).
- `src/server/matchmaking.ts`: the in-memory queue (±500, +500 every 10 s, pair oldest first on max of both ranges, 15 s poll keep-alive, `matched` kept 30 s), hosted by the `Accounts` object behind `/api/account/queue/{join,status,leave}`.
- `Accounts`: new `ratings` and `ranked_matches` tables (no migration), `me.rating {tr, games}`, `sessionKey` shared with the Worker (RPC `sessionAccount`), and `reportRanked` (RPC) that rates a registered match once.
- `Match`: `registerRanked` RPC; `?mode=ranked` sockets need a session the Worker resolved (header `X-Teza-Account`, stripped from incoming requests) and must be one of the two accounts; create/join on a ranked code get 409. `MatchSession` takes an optional ranked config, reports a finished match once and holds `end` up to 3 s for the per-player `rating`.
- Client: `OnlineResult.rating`; VERSUS gets RANKED 1V1 (RANKED is a bot), a queue screen, and a TR line on ranked results. The VERSUS stack is seven bars now; Poster Slab's dense bars are a little tighter so they still fit 1280x720.
- Checked on `wrangler dev --local-upstream` with two Chromium profiles: paired in about 1.5 s, no countdown, TR HIDDEN on both results for new accounts; after 19 ranked games (17 played by a Node WebSocket script) the TR shows, and the next browser match read `TR 12,477 -16` and `TR 12,523 +16`. Room matches still work and show no TR line.

**Still open**
- About 17 games before a TR shows; no placement rules beyond that.
- A player who leaves the queue while their room is being registered isn't told about it; the other waits alone until the lobby timeout (2 min).
- If the `Match` object restarts between pairing and the sockets, the ranked room is gone (the sockets get 404, the client says it couldn't join).

## 2026-10-18 — Leaderboard, public profiles and ranked hardening (factory job 015)

**What changed**
- `GET /api/leaderboard` (top 50 calibrated accounts by TR, then games, then username) and `GET /api/profile/<username>` (`{username, joined, rating: {tr, games}, rank}`), public, GET only, `Cache-Control: public, max-age=30`, in `src/server/leaderboard.ts` over a new read-only `AccountStore.calibrated()`; the Worker forwards both to `Accounts`.
- Solo PBs and the bot W–L are not shown publicly: they are an unverified client upload and `?seed=` makes a sequence replayable. The private records sync is unchanged.
- Hardening from the job 014 review: the same two accounts pair at most 3 times per 24 h (`rated_pairs` table written with the ratings, `Matchmaker`'s injected `mayPair`); a ranked lobby waits 30 s and a one-sided no-show is reported over `Accounts.reportNoShow`, which drops the room unrated and cools the absent account down for 120 s (429 with `Retry-After` on `queue/join`); `openRoom` is bounded by 3 s and a timeout requeues the pairing; the Worker answers a ranked upgrade without a well-formed `teza_session` token with 401 before calling `Accounts`.
- Client: VERSUS has an eighth bar, LEADERBOARD, with LEADERBOARD and PROFILE pages in both themes. Classic keeps its VERSUS bar sizes (84 px, 38 px titles) where eight fit (900 px tall and up, and the stacked phone layout); shorter side-by-side screens get a tighter stack (70 px, 32 px). Classic sets a sub-page title longer than eight letters smaller. The RANKED screen shows the cooldown instead of searching.
- Round 2 (security review): the pair cap counts the pair's open rooms as well as rated matches and is checked again at rating time; a no-show is taken out of the queue and a cooling account is never paired; a dodger who took a slot and disconnected is reported when the other player is the only one connected.
- Checked on `wrangler dev --local-upstream` with a Node script: a ranked lobby with only one socket ended `no-opponent` after 30.0 s, the absent account's join got 429 `Retry-After: 120` and the present one 200; three idle-draw ranked matches between the same two accounts, then the fourth search left both waiting.

**Still open**
- A verified solo leaderboard (server-issued seeds or replay verification).
- The no-show cooldown is in memory and resets when the `Accounts` object restarts; there are no escalating penalties.
- With the pair cap, two friends alone in the queue get 3 rated games a day together; calibrating (about 17 games) needs other opponents.

## 2026-10-18 — Server hardening: socket, accounts and CSP (factory job 016)

**What changed**
- Socket: the match upgrade and `POST /api/room` refuse an `Origin` that is neither the request URL's own nor `https://teza.comonhq.com` (403, before any Durable Object call; no `Origin` passes). The resume token moved from `?resume=&ack=` (now 400) to `Sec-WebSocket-Protocol: teza, resume.<token>.<ack>`; the 101 answers `teza` only. Tokens are compared with `timingSafeEqual` against every slot.
- Issued room codes: `POST /api/room` reserves its code with that code's `Match` object (RPC `issueRoom`, a claim in DO storage for 2 minutes, an alarm deletes it unused; 5 tries then 503). `mode=create` needs a live claim and uses it up (404 `Room code was not issued` otherwise).
- Accounts: cookie renamed `__Host-teza_session` (`Path=/`), with a read-only fallback to the legacy `teza_session` (remove 30 days after deploy); sign-in expires the legacy cookie and ends the account's other sessions; register answers 503 once 500 accounts were created in the last 24 h (round 2, replacing a lifetime cap a script could fill for good; 200000 stays as a storage backstop); `sessions` indexed on `expires_at` and `username_key`.
- SIGN OUT: a 400 on the last records upload no longer keeps the player signed in.
- CSP: `build.mjs` writes `dist/_headers` with a strict policy and the inline theme script's hash; the e2e server sends it. `el()` now sets `style` through the CSSOM (`style.cssText`), since the policy refuses `style` attributes (the `--accent`/`--i`/`--len` custom properties were being set that way).
- Round 3: at most 5 registrations per client IP per 24 h (SHA-256 of `CF-Connecting-IP`, 429 with `Retry-After`) in front of the daily cap, so one machine can't hold sign-ups shut.
- Round 4: IPv6 clients are counted per /64 (`ipBucket`: expand `::`, keep four groups, lowercase and zero-pad), and `::ffff:a.b.c.d` counts as its IPv4, since one VPS can rotate through a whole /64. README no longer presents the unsalted SHA-256 as anonymisation.
- Round 5: a second IPv6 tier, 20 per /48 next to 5 per /64 (one `registrations` row per bucket, `Retry-After` the longer wait), since a free Hurricane Electric /48 or a /56 home line could still fill the cap; unparseable `CF-Connecting-IP` values share one `invalid` bucket. Keep Cloudflare's "Pseudo IPv4" off.
- Round 6: the daily cap (500 a day) is gone; the per-IP and per-/48 quotas stay. `MAX_ACCOUNTS` is now 1,000,000, sized by the Accounts object's 10 GB SQLite limit (measured 6,708 bytes per account at the largest valid records, 522 with empty ones, so 200,000,000 would not fit), and from 800,000 every 10,000th account logs one structured `console.warn` (`accounts_near_capacity`). The `accounts_by_created` index went with the daily cap.
- JOIN ROOM's server check is `GET /api/room` (200 `{online: true}`), which reserves nothing.
- Checked on `wrangler dev --local-upstream` (4.150.0): `_headers` applied to `/` and assets (and not served itself); headless Chromium in both themes with zero CSP violations, theme set before the stylesheet, service worker registered and controlling after reload, fonts loaded; a room (Classic creates, Poster Slab joins) and a ranked match both reached play. A `teza_session` made by main's Worker still signed in after the switch; logging in replaced it with `__Host-teza_session`.

**Still open**
- The client still has no auto-reconnect over the resume subprotocol.
- Remove `LEGACY_COOKIE_NAME` 30 days after this deploys.
