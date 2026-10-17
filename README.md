# TEZA

*Tetris + cheza (Swahili for "play").*

A clean-room rebuild of TETR.IO's gameplay: 40 LINES, BLITZ, ZEN, and VERSUS against a bot or, online, against a friend.
The mechanics were taken from the official client: SRS+ kicks, 180° kicks, the T-spin corner rule, all-mini+
spins, the attack/B2B-chaining/combo formulas, lock delay, DAS/ARR/DCD/SDF, the Park–Miller 7-bag RNG
and the 40L/Blitz presets. See `docs/MECHANICS.md`.

None of osk's code, art, music, sounds or fonts is included. The constants were read and the engine was written from scratch.

## Run

```bash
npm install
npm start          # → open http://localhost:3000 (rebuilds when you save a file)
```

Other scripts: `npm run check` (typecheck + tests + build) and `npm run build` (production build into `dist/`; it's plain static files, so any web server can host it).

### End-to-end runs

```bash
npx playwright install chromium   # once, downloads the browser Playwright drives
npm run e2e
```

`npm run e2e` builds `dist/`, serves it from a small static server on a free localhost port (no dev server or network needed) and plays two full games in headless Chromium, once in each interface theme (Classic opens on the menu, Poster Slab on its title screen, which the run skips with a key): a 40 LINES run to `40 LINES CLEARED` and a 2-minute BLITZ run to `TIME'S UP`. Each run opens the game with `?seed=7` (a `?seed=<positive integer>` URL parameter fixes the piece sequence) and presses keys from a plan the game's own bot computes in Node (`e2e/plan.ts`). Playwright's fake clock drives time, so the runs are identical every time and take about 4 minutes of real time. The BLITZ score in the browser must equal the score of the same inputs replayed in Node, the 40 LINES run's stored PB replay (see PB ghost) must replay in Node to the same clear, frame count and pieces, and any page error or `console.error` fails the run. `e2e/themes.e2e.ts` checks the themes: the theme set before first paint, each theme's first screen, switching in CONFIG (live, after a reload, and RESET), Classic's Z drop with and without reduced motion, and, in both themes, VERSUS's CREATE ROOM and JOIN ROOM bars (all six bars fit 1280x720, the static server's 204 gives `Online play isn't available here`, and JOIN's field is styled). The e2e files (`e2e/*.e2e.ts`) are not part of `npm test` or `npm run check`.

## Deploy

Every push to `main` deploys to Cloudflare Workers through `.github/workflows/deploy.yml`. It runs `npm ci` and `npm run check`, then `wrangler deploy` publishes `dist/` as static assets plus the game server Worker (see `wrangler.jsonc`). The job then checks that `/` and `/game.js` load from https://teza.comonhq.com, and that `/api/match/CHECK2` (no upgrade header) returns 426, which proves the Worker route is live and not only the assets.

The Worker is served only on the custom domain `teza.comonhq.com` (`routes` with `custom_domain: true`); `workers_dev` is off, so there is no `*.workers.dev` URL that would skip the zone's rate limit.

The workflow needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission on the account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

To deploy by hand, run `npm run build`, then `npx wrangler deploy`.

Live URL: https://teza.comonhq.com/

### Offline and install (PWA)

The fonts (Big Shoulders Display, Archivo Narrow, Russo One, Saira Semi Condensed; SIL Open Font License, see `fonts/OFL-*.txt`) are self-hosted from `fonts/`, so the page makes no request to Google Fonts. `manifest.webmanifest` and the icons in `icons/` (see [Brand](#brand)) make the game installable.

`sw.js` is a service worker that precaches the static build (`index.html`, `style.css`, `game.js`, the manifest, fonts and icons; not the share image, which only link previews fetch) on first load and then serves those cache-first, so solo modes work offline. `npm run build` stamps a hash of the build into its cache name, so each deploy gets a fresh cache and the old one is deleted. It only handles same-origin `GET`s: **`/api/*` (accounts, match WebSockets) is never intercepted or cached**, and neither are other methods or cross-origin requests. Under `npm start` the served `sw.js` is a no-op worker, so live rebuilds are never stale; to try offline mode locally, serve a production `dist/` instead.

## Game server

The `teza` Worker (`worker/index.ts`) serves `dist/` as static assets. Only `/api/*` runs the script:

- `POST /api/room` returns 201 `{code}`: a room code of 6 symbols from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O, 1/I/L), drawn with `crypto.getRandomValues` (`newRoomCode` in `src/server/match.ts`). Nothing is stored: the room exists once its creator's socket holds a slot. Any other method gets 405 with `Allow: POST`.
- `GET /api/match/<code>?mode=create` or `?mode=join` with `Upgrade: websocket` opens or joins the room. The room code is the match id: each gets its own `Match` Durable Object, which holds both sockets and runs one headless engine per player. A path that isn't a room code gets 400 (whatever the method), a non-GET 405, and no upgrade header 426. On the upgrade, a missing or other `mode` gets 400, `create` on a room someone already holds gets 409 (`Room code taken`, so nobody can take over a live code), and `join` on a room nobody holds gets 404 (`No such room`). A third player joining a full room is upgraded, then gets `error` (`full`) and is closed.
- `GET /api/match/<code>?resume=<token>&ack=<peerAck>` is the same upgrade for a player coming back, without `mode`: the token is checked before the socket is accepted (malformed parameters give 400, an unknown token 403), and the socket takes its slot at once. `ack` defaults to 0.
- `/api/account/*` is the accounts API (see Accounts below).
- Any other `/api/*` path returns 404.

All of `/api/*` (the room, match and account routes) is rate-limited per IP by a Cloudflare rate-limiting rule in the comonhq.com zone (hostname `teza.comonhq.com`, path `/api/*`, action block). The rule is dashboard config that lives in the zone, not in this repo: if the domain changes, recreate it for the new hostname. Clients must call the API same-origin with a relative URL (`/api/room`, `/api/match/<code>`), never a hardcoded host. With 887 million codes behind that limit, guessing a live room is impractical, so rooms have no other secret.

Server hardening done so far: room codes are random and generated by the server on request (`POST /api/room`), though nothing enforces that a code came from there, so a client can still open any well-formed code; and the create/join flag above. Not done yet: an `Origin` check on the upgrade, moving the resume token out of the URL, a constant-time token compare, and a CSP.

The match logic lives in `src/server/match.ts`, which has no Cloudflare imports so the tests can drive it with a fake clock.

Messages are JSON envelopes `{t, s, a, d}` in both directions: type, sequence number (per player slot, +1 per packet sent), ack (last `s` received from the other side) and payload. The server keeps each slot's last 100 packets for reconnects.

| Server to client | `d` |
|---|---|
| `welcome` | `{slot, token}`: slot 0 or 1 and the resume token |
| `start` | `{seed, options, handling}`: both players get the same seed, the VS rules and the handling the server replays inputs with (DAS/ARR/DCD/SDF and IRS/IHS; a client must use it, not its own settings, to stay in sync) |
| `opponentInput` | `{frame, action, kind}`: an input the server accepted from the opponent, with the frame the server's engine applied it at. That is the input's frame floored to the 1/256 grid, unless the engine was already past it, in which case it is the engine's frame: the relayed frame always equals the applied one |
| `garbage` | `{amount, frame}`: attack received, applied to your engine at `frame`, after the inputs of yours the server had read by then (the envelope's `a`) |
| `opponentGarbage` | `{amount, frame}`: sent to the attacker with every `garbage` the opponent gets, with the same `frame`, so the attacker's copy of the opponent's board takes it where the server did. Packets go out in the order the server applied them |
| `opponentDisconnected` | `{grace}`: ms the opponent has to come back (15000) |
| `opponentReconnected` | none |
| `end` | `{winner, reason}`: reason is `topout`, `disconnect` or `idle`; `winner` is null for a draw; sent once |
| `error` | `{code, message}`; a refused `input` adds its `s`, so the client can take it back out of its predicted board |
| `pong` | none |

| Client to server | `d` |
|---|---|
| `input` | `{frame, action, kind}`: action is `left right soft hard cw ccw 180 hold`, kind is `press` or `release` |
| `resume` | `{token, peerAck}`: rebind a slot on a new socket, then get the missed packets with `s > peerAck`. Prefer `?resume=` on the upgrade, which does the same and can't be crowded out |
| `ping` | anything; answered with `pong` |

The creator (`mode=create`) takes slot 0 and the joiner slot 1, and the match starts when both are connected. A third socket gets `error` (`full`) and is closed. If no second player joins within 2 minutes, the first gets `error` (`no-opponent`), its socket is closed and the room code can be created again.

There is no server tick. Engines advance when a message arrives: a player's engine moves to the frame of each input it accepts, floored to the 1/256-frame grid and stepped through whole frames as a client steps (`src/engine/stepping.ts`), and any engine more than 120 frames behind the server clock (ms since `start` × 60 / 1000) is first moved up to that limit, as if the player pressed nothing. A player who goes quiet therefore keeps falling and can still top out. Lagging engines are caught up together, frame by frame, so whoever tops out first loses; both on the same frame is a draw. An input is rejected with `error` and leaves the engine alone when:

- the action or kind is unknown, or `frame` is not a number;
- `frame` is lower than that player's last accepted frame;
- `frame` is more than 30 frames ahead of the server clock, or more than 120 frames behind it;
- the player is over the input budget: a token bucket per player that holds 90 inputs and refills at 60 a second, so a burst of up to 90 arrives fine and the average stays at 60 a second.

More than 20 rejected messages (including messages over 1 KB or not JSON) close the socket. When a socket closes mid-match the opponent gets `opponentDisconnected`; the player has 15 s to reconnect with `?resume=<token>&ack=<peerAck>` (or to send `resume` on a new socket), or they forfeit. While a slot is free, at most 2 sockets without a resume token may wait to resume (more get `busy`), and each must send `resume` within 5 s (else `resume-timeout`). A socket with a valid token on the upgrade never waits, so other sockets can't block the owner's reconnect. A wrong token gets `error` and the socket is closed. If the missed packets have already left the 100-packet buffer, the server sends `error` with code `resync` instead of a partial replay. If neither player sends a valid message (an accepted input, a ping or a resume) for 60 s after `start`, both engines are run to the server clock: a top-out decides the match, otherwise it ends as a draw with reason `idle`. After `end` the server closes both sockets, and new sockets get `error` (`ended`) and are closed.

### Online client

VERSUS has two more bars under the bots. CREATE ROOM asks `POST /api/room` for a code, opens the socket with `mode=create` and shows the code large with `Waiting for opponent… (ESC to cancel)`. JOIN ROOM shows a field (uppercase letters and digits, 6 at most); Enter opens the socket with `mode=join`. A browser can't read the status of a refused upgrade, so a socket that closes before `welcome` without an `error` reads as `No such room`, and `full` (or a room whose free slot is waiting for its owner) as `Room is full`. JOIN first checks with `POST /api/room` (which stores nothing) that a game server is there. Without one (`npm start`, the e2e server, offline) both bars say `Online play isn't available here` and stay on the page. The socket URL is built from `location`, never a fixed host.

`src/net/online.ts` (no DOM, tested against `MatchSession` in `test/online.test.ts`) holds the protocol and the prediction; `app.ts` only hands it a WebSocket:

- The match starts with no countdown: the client's clock is 0 when `start` arrives and runs on wall time (frames = ms × 60 / 1000), as the server's does. Both games are built from `start.options` and `start.handling`, never local settings, and `?seed=` is ignored.
- Your board is predicted. A key applies at once, with the canonical stepping (`stepToClock(game, clock, true)`), and goes out as `input {frame: clock}`. Inputs are paced by a token bucket at the server's rate but with a burst of 30, not 90 (extra ones wait and apply when sent, so the board and the server stay equal). Over any span the client sends at most 30 + 60 a second, and the socket keeps their order, so however jitter bunches them, the server receives at most 30 + 60 × (span + jitter): that fits its 90 for up to 1 s of jitter (`test/online.test.ts` bunches packets with 900 ms stalls at the cap). If the server refuses an input anyway, the client rewinds and replays without it, as for garbage; a refused press no longer counts as held, and a refused release is sent again. Frames never go down, and a `ping` goes out after 10 s without traffic.
- Garbage is the server's call. The client keeps a snapshot of its game every 15 frames (the last 30 s) and a log of what it applied. On `garbage {amount, frame}` it puts the garbage in the log after the inputs the server had read (the envelope's ack), rewinds to the last snapshot before that point, replays silently to its clock, and so holds the board the server's engine will have. Attacks your own board predicts are drawn as flights, but only the server sends garbage.
- The opponent's board is a second game stepped only by `opponentInput` and `opponentGarbage`, at their frames. Between packets it rests at the last relayed frame; nothing is extrapolated.
- On window blur the client releases each held action on its own, here and on the server (not `releaseAll`), and does not press them again on focus.
- Only the server's `end` decides the match. A local top-out stops input, shows `TOPPED OUT · WAITING` and sends one `release soft` at the clock so the server's engine reaches the top-out at once. `opponentDisconnected` shows `OPPONENT DISCONNECTED · 15s` counting down over the opponent's board; a server `error` shows over yours for 3 s. A socket that closes before `end` ends the session as `CONNECTION LOST`.
- Results show YOU WIN, YOU LOSE or DRAW with the reason (top-out, disconnect, idle) and a single MENU action; there is no rematch. ESC in a match closes the socket, and the opponent wins after the server's 15 s grace. Online results are not saved to the bot W–L record or to the account.
- No auto-reconnect: the server's `?resume=` stays, but the client does not use it yet.

To try it locally, run `npm run build`, then `npx wrangler dev --local-upstream 127.0.0.1:8787 --port 8787` and open the page in two browser windows.

## Accounts

Signing in is optional: without an account the game keeps records in localStorage only, exactly as before. With one, personal bests and bot W–L follow you between browsers.

`/api/account/*` goes to a single `Accounts` Durable Object (`idFromName("accounts")`, SQLite storage, migration `v2`). The logic lives in `src/server/accounts.ts`; the records shape, its validator and the merge rule are in `src/profile.ts`, shared with the client. All routes speak JSON. POST and PUT need `Content-Type: application/json` (else 415) and a body of at most 4 KB (else 413).

| Route | Body | Result |
|---|---|---|
| `POST /api/account/register` | `{username, password}` | 201 and signed in; 409 if the name is taken (case-insensitive) |
| `POST /api/account/login` | `{username, password}` | 200 and signed in; 401 with the same message for an unknown user or a wrong password |
| `POST /api/account/logout` | none | 200; deletes the session and clears the cookie |
| `GET /api/account/me` | | 200 `{username, createdAt, records}`, or 401 |
| `PUT /api/account/records` | `{records}` | 200 `{records}` after merging, or 401 without a session |

Usernames are 3-16 characters of `A-Z a-z 0-9 _ -`; passwords are 8-128 characters. Anything else gives 400 with a message. Passwords are stored only as PBKDF2-SHA-256 with a random 16-byte salt and 100000 iterations (`pbkdf2-sha256$<iterations>$<salt>$<hash>`).

A session is a random 32-byte token in the cookie `teza_session` (`HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=2592000`, 30 days); the server stores only its SHA-256. POST and PUT requests whose `Origin` header is present and is not the site's own origin get 403.

Records have the same shape as the client's `teza:records`. A `PUT` is merged with what the server has and the better value wins: fewer frames for 40L, a higher score for Blitz, the larger wins and losses count per bot. Records with non-finite or negative numbers, a 40L time outside 1..10^7 frames, unknown keys, more than 20 bot names or a bot name over 32 characters are refused with 400 and change nothing. The client calls `me` on start; when signed in it merges local and server records the same way, saves the result locally and `PUT`s it, and it `PUT`s again after every finished run. SIGN OUT (labelled SIGNING OUT… while it waits) sends a last `PUT`, then logs out, then clears the local records so the next player on a shared device starts fresh. A 401 from the `PUT` or the logout means the session has already ended, so the client treats it as signed out and clears the local records too; after a 401 on the `PUT` that last upload is lost and logout is skipped. If either request fails any other way (another non-2xx status, a network error, or no answer within 8 s, the timeout on every account request), the player stays signed in with their local records and the menu shows "Couldn't sign out — check your connection". Any other failed call never blocks play.

Login and register are covered by the zone's per-IP rate-limit rule on `/api/*` (see Game server). That rule is dashboard config in the comonhq.com zone, not code in this repo.

For local testing of the API, build and run `npx wrangler dev --local-upstream 127.0.0.1:8787` (with the port you use). Without `--local-upstream`, wrangler rewrites the request URL to the route host `teza.comonhq.com`, so the browser's own `Origin` doesn't match and sign-in gets 403. `npm start` serves only static files, so the account screen there says accounts aren't available.

## PB ghost (40 LINES)

Every 40 LINES run records the player's inputs (`src/engine/replay.ts`). When a run is a clear and a new personal best, its replay is saved to `localStorage["teza:ghost40l"]` as plain JSON: `seed`, the `handling` in effect (DAS/ARR/DCD/SDF, IRS/IHS), `frames` (the PB time) and `events` (each press, release or releaseAll with the game frame it landed on). It is not part of `teza:records` and is never sent to the accounts server. Slower clears and top-outs leave it alone.

Starting 40 LINES loads it when it parses and its `frames` equals the stored PB. The PB run then plays as a translucent PB GHOST board to the right of the player, with its own seed and its saved handling (not the current settings), in lockstep from GO. It freezes at 40 lines. A marker above its spawn rows shows the lines difference (`GHOST +3`, `YOU +2` or `EVEN`). The ghost shows no clear names (SINGLE, COMBO…). When the window is too narrow for a readable ghost (a cell under 8 px), the ghost is not drawn. A PB from another device or an older build has no matching replay, so no ghost appears.

To make a replay exact, every game (the player in any mode, the VS bot, a replay and the match server's engines) rests only on whole frames between inputs, and inputs land on a 1/256-frame grid (`src/engine/stepping.ts`). The display is at most one frame behind the clock between inputs; inputs still apply at their own time.

## Controls (TETR.IO defaults, rebindable in CONFIG)

| Action | Keys |
|---|---|
| Move | ← → |
| Soft / hard drop | ↓ / Space |
| Rotate CW / CCW / 180 | ↑ or X / Z or Ctrl / A |
| Hold | C or Shift |
| Retry / Menu | R / Esc |

## Sound and music

Everything is synthesized with Web Audio at runtime: no audio files. The music runs through light saturation and a compressor into its own bus; the sound effects have their own bus. Both feed one master output.

CONFIG › AUDIO & VISUAL has four audio settings, saved in `localStorage["teza:settings"]`:

- **Sound effects** (`volume`, default 60%).
- **Music** (`musicVolume`, default 60%). At 0% the music makes no sound and creates no voices.
- **Music track** (`musicTrack`): Auto (the default: a song per mode, and one for the menus), one song played everywhere, or Off (no music and no scheduler). An unknown saved value falls back to Auto.
- **Sound pack** (`soundPack`): Arcade (square/triangle chip, the default), Glass (sine and FM bells, soft) or Neon (detuned saws, heavy bass). A pack sets the waveforms, filter brightness and envelopes of both the effects and the music (`src/audio/packs.ts`). A change during play applies from the next sound and the next bar. An unknown saved pack falls back to Arcade.

Saves from before these settings existed load unchanged; missing fields take their defaults.

### Songs

Songs are data in `src/audio/songs.ts`: key, chord loop, swing, kit level and, per gear, a tempo and one-bar patterns for kick, snare, hats, bass, pad, arpeggio and lead. Add a song by appending to `SONGS`. Give it a `mode` to make it that mode's Auto song. Every song is listed under Music track.

| Song | Auto in | Feel | Key | Tempo by gear (BPM) |
|---|---|---|---|---|
| Lantern | menus and results | relaxed, warm | F major | 92 |
| Gridline | 40 LINES | driving four-on-the-floor | E dorian | 118 / 126 / 134 / 152 |
| Afterburn | BLITZ | frantic synthwave | A minor | 130 / 138 / 146 / 162 |
| Undertow | VERSUS | dark, aggressive | C♯ phrygian | 108 / 116 / 124 / 142 |
| Tidepool | ZEN | ambient lo-fi, swung | D major | 72 / 76 / 80 (no danger gear) |

The menu song starts with your first key press or click. Starting a mode crossfades into its song over the 1.5 s countdown. When the run ends (top-out, finish, K.O.) or you leave it, the menu song crossfades back over 2.5 s. Retry starts the mode's song again from the top.

### Gears

During a run the music moves in steps, called gears, driven by an intensity value from 0 to 1. Intensity is the strongest of:

- the player's danger (the value that reddens the board near the top);
- the stack height plus incoming garbage, at 0.05 per row;
- a running combo;
- in BLITZ's last 30 seconds, a ramp from 0.4 to 1.

| Gear | Intensity | Typical board |
|---|---|---|
| calm | 0 | empty |
| groove | ≥ 0.15 | 3-row stack, or 1 COMBO |
| drive | ≥ 0.4 | 8-row stack, 3 COMBO, or BLITZ's last 30 s |
| danger | ≥ 0.7 | 14-row stack (stack plus garbage in VERSUS), or BLITZ's last 15 s |

Each gear has its own tempo and a denser arrangement. The danger gear is a jump of 15 BPM or more, with double-time hats, a driving bass and an alarm lead. A gear change lands on the next beat: a crash marks a step up, and a falling sweep marks a step down. A gear holds until intensity falls 0.08 below its threshold, so it drops back after you dig down rather than fluttering. In BLITZ the tempo also multiplies by up to ×1.25 over the last 30 seconds, so Afterburn's danger gear reaches about 200 BPM at time-up.

Each kick ducks the rest of the music (sidechain). Combos (from 1 COMBO) add a melody phrase in the song's key that starts on the next 16th note and grows longer and higher up to 8 COMBO. The phrase is cut when the combo ends. Each of your line clears ducks the music for about a third of a second, and quads, spins and all clears duck it deeper. The effects' chords follow the playing song's key. The bot's sounds are centred. Your piece sounds (move, rotate, hold, drop, spin, clear) are panned left or right by the piece's column. The thresholds and intensity mix are in `src/audio/music.ts` (`GEARS`, `musicIntensity`).

## Brand

Two interface themes, picked in CONFIG › STYLE › Interface theme and saved per device in `teza:settings` (`theme`). RESET TO DEFAULTS returns to Classic.

- **Classic** (the default): the original look. Dark background, the stacked TE over ZA wordmark on the left with the signed-in stats under it, and the coloured stepped mode bars. It opens straight on the menu. Russo One for display, Saira Semi Condensed for body text, ZA in blue `#3F6BFF` on `#08080F`.
- **Poster Slab**: ink, paper, a red slab and a green stripe, in Big Shoulders Display and Archivo Narrow. It opens on a title screen where T, E, Z and A drop into the slab like pieces, lock with a one-frame squash, and the CHEZA row clears and wipes away to the menu. Any key, click or tap skips it. Clicking the wordmark on the menu replays it. With reduced motion (the OS setting or CONFIG › Reduce motion) it shows its last frame and waits for a key. Palette: ink black `#0B0B0C`, paper white `#F3EFE6`, signal red `#E0301E`, field green `#0F6B3E`.

How themes work:

- **Registry**: `src/ui/themes.ts` lists each theme's id, name, tagline and `theme-color`. The CONFIG select, the setting's validation and `App` all read it. `App` sets `<html data-theme="<id>">` and the `theme-color` meta, and builds each screen's markup for the theme (Classic's stacked brand, or Poster's slab and title screen).
- **Before first paint**: a small inline script in `index.html`'s `<head>`, ahead of the stylesheet, reads the saved theme and sets `data-theme` and `theme-color`, so the wrong theme never flashes. It knows the same ids and colours as the registry (`test/themes.test.ts` checks that) and falls back to Classic.
- **CSS**: `style.css` scopes Classic's rules to `html:not([data-theme="poster"])` and Poster Slab's to `html[data-theme="poster"]`, each inside `:where()` so specificity is as before. Classic is therefore the look when the attribute is missing or unknown. A new theme is a registry entry, its CSS scope (added to Classic's `:not()` if it replaces Classic entirely) and its entry in the inline script.

The marks:

- **Wordmarks**: the Z is drawn in SVG (`src/ui/brand.ts`, `Z_PIECES`): a heavy Z cut into four pieces laid out like a Z-tetromino's cells. Classic's `classicWordmark()` is the original TE over ZA heading in Russo One with that Z in place of the letter, stretched to Russo One's Z so ZA sets exactly as before. Each time the menu opens, its four pieces drop in and lock, bottom row first (about 0.6 s, not with reduced motion). Poster's `wordmark()` is TEZA in Big Shoulders Display 900, used on the title screen, the menu slab and the ACCOUNT, VERSUS and CONFIG headers.
- **Icons**: Classic's. The Z-tetromino as four cells on `#08080F`, three blue and the last one white. `icons/favicon.svg` is the same cells with no side padding. The maskable icon keeps the cells inside the central 80% safe circle. `manifest.webmanifest` uses `#08080F` for `theme_color` and `background_color`. The icons do not change with the theme.
- **Share image**: `og/og-image.png`, 1200x630, in Classic: the stacked TE/ZA wordmark with the blue cut Z, "Tetris + cheza / Swahili for play" and "Built in Kenya" on dark. `index.html` points Open Graph and Twitter cards at `https://teza.comonhq.com/og/og-image.png`.
- **Regenerating**: `npm run brand` (`scripts/brand.mjs`) rewrites `icons/favicon.svg`, the four PNG icons and `og/og-image.png`. It draws them in SVG/HTML from the same `Z_PIECES` and fonts, and screenshots them with Playwright's Chromium (the `@playwright/test` devDependency; run `npx playwright install chromium` once). It is not part of `npm run build`, so commit the outputs after running it.

## Layout

- `src/engine/` — deterministic, headless engine (sub-frame input timing, same as the original), canonical stepping (`stepping.ts`) and 40L replays
- `src/server/` — online match and accounts logic (runtime-independent; the Worker in `worker/` wraps each in a Durable Object)
- `src/profile.ts` — records type, validator and merge, shared by the client and the accounts server
- `src/ai/bot.ts` — VS opponent: searches every placement, including soft-drop + spin finishes
- `src/render/` — canvas renderer (board spring physics, particles, action text)
- `src/audio/` — synthesized WebAudio SFX, sound packs and generative music
- `src/ui/` — themes, title screen, wordmarks, menus, config, results, session orchestration
- `scripts/brand.mjs` — regenerates the icons, favicon and share image (`npm run brand`)
- `test/` — engine, bot, match server and accounts tests (vitest)
- `e2e/` — browser runs of 40 LINES and BLITZ (Playwright, `npm run e2e`)
