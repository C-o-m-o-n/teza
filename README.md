# TEZA

*Tetris + cheza (Swahili for "play").*

A clean-room rebuild of TETR.IO's gameplay: 40 LINES, BLITZ, ZEN, and VERSUS against a bot.
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

`npm run e2e` builds `dist/`, serves it from a small static server on a free localhost port (no dev server or network needed) and plays two full games in headless Chromium: a 40 LINES run to `40 LINES CLEARED` and a 2-minute BLITZ run to `TIME'S UP`. Each run opens the game with `?seed=7` (a `?seed=<positive integer>` URL parameter fixes the piece sequence) and presses keys from a plan the game's own bot computes in Node (`e2e/plan.ts`). Playwright's fake clock drives time, so the runs are identical every time and take about 1.5 minutes of real time. The BLITZ score in the browser must equal the score of the same inputs replayed in Node, and any page error or `console.error` fails the run. The e2e files (`e2e/*.e2e.ts`) are not part of `npm test` or `npm run check`.

## Deploy

Every push to `main` deploys to Cloudflare Workers through `.github/workflows/deploy.yml`. It runs `npm ci` and `npm run check`, then `wrangler deploy` publishes `dist/` as static assets plus the game server Worker (see `wrangler.jsonc`). The job then checks that `/` and `/game.js` load from https://teza.comonhq.com, and that `/api/match/ci-check` (no upgrade header) returns 426, which proves the Worker route is live and not only the assets.

The Worker is served only on the custom domain `teza.comonhq.com` (`routes` with `custom_domain: true`); `workers_dev` is off, so there is no `*.workers.dev` URL that would skip the zone's rate limit.

The workflow needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission on the account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

To deploy by hand, run `npm run build`, then `npx wrangler deploy`.

Live URL: https://teza.comonhq.com/

### Offline and install (PWA)

The fonts (Russo One, Saira Semi Condensed; SIL Open Font License, see `fonts/OFL-*.txt`) are self-hosted from `fonts/`, so the page makes no request to Google Fonts. `manifest.webmanifest` and the placeholder icons in `icons/` make the game installable.

`sw.js` is a service worker that precaches the static build (`index.html`, `style.css`, `game.js`, the manifest, fonts and icons) on first load and then serves those cache-first, so solo modes work offline. `npm run build` stamps a hash of the build into its cache name, so each deploy gets a fresh cache and the old one is deleted. It only handles same-origin `GET`s: **`/api/*` (accounts, match WebSockets) is never intercepted or cached**, and neither are other methods or cross-origin requests. Under `npm start` the served `sw.js` is a no-op worker, so live rebuilds are never stale; to try offline mode locally, serve a production `dist/` instead.

## Game server

The `teza` Worker (`worker/index.ts`) serves `dist/` as static assets. Only `/api/*` runs the script:

- `GET /api/match/<id>` with `Upgrade: websocket` joins match `<id>`. Each id gets its own `Match` Durable Object, which holds both sockets and runs one headless engine per player. `<id>` must match `^[A-Za-z0-9_-]{1,32}$` (else 400). Without the upgrade header the route returns 426.
- `GET /api/match/<id>?resume=<token>&ack=<peerAck>` is the same upgrade for a player coming back: the token is checked before the socket is accepted (malformed parameters give 400, an unknown token 403), and the socket takes its slot at once. `ack` defaults to 0.
- `/api/account/*` is the accounts API (see Accounts below).
- Any other `/api/*` path returns 404.

All of `/api/*` (the match and account routes) is rate-limited per IP by a Cloudflare rate-limiting rule in the comonhq.com zone (hostname `teza.comonhq.com`, path `/api/*`, action block). The rule is dashboard config that lives in the zone, not in this repo: if the domain changes, recreate it for the new hostname. Clients must call the API same-origin with a relative URL (`/api/match/<id>`), never a hardcoded host.

The match logic lives in `src/server/match.ts`, which has no Cloudflare imports so the tests can drive it with a fake clock.

Messages are JSON envelopes `{t, s, a, d}` in both directions: type, sequence number (per player slot, +1 per packet sent), ack (last `s` received from the other side) and payload. The server keeps each slot's last 100 packets for reconnects.

| Server to client | `d` |
|---|---|
| `welcome` | `{slot, token}`: slot 0 or 1 and the resume token |
| `start` | `{seed, options}`: both players get the same seed and the VS rules |
| `opponentInput` | `{frame, action, kind}`: an input the server accepted from the opponent |
| `garbage` | `{amount, frame}`: attack received, applied at your current server frame |
| `opponentDisconnected` | `{grace}`: ms the opponent has to come back (15000) |
| `opponentReconnected` | none |
| `end` | `{winner, reason}`: reason is `topout`, `disconnect` or `idle`; `winner` is null for a draw; sent once |
| `error` | `{code, message}` |
| `pong` | none |

| Client to server | `d` |
|---|---|
| `input` | `{frame, action, kind}`: action is `left right soft hard cw ccw 180 hold`, kind is `press` or `release` |
| `resume` | `{token, peerAck}`: rebind a slot on a new socket, then get the missed packets with `s > peerAck`. Prefer `?resume=` on the upgrade, which does the same and can't be crowded out |
| `ping` | anything; answered with `pong` |

The first two sockets take slots 0 and 1, and the match starts when both are connected. A third socket gets `error` (`full`) and is closed. If no second player joins within 2 minutes, the first gets `error` (`no-opponent`), its socket is closed and the match id starts fresh.

There is no server tick. Engines advance when a message arrives: a player's engine moves to the frame of each input it accepts, and any engine more than 120 frames behind the server clock (ms since `start` × 60 / 1000) is first moved up to that limit, as if the player pressed nothing. A player who goes quiet therefore keeps falling and can still top out. Lagging engines are caught up together, frame by frame, so whoever tops out first loses; both on the same frame is a draw. An input is rejected with `error` and leaves the engine alone when:

- the action or kind is unknown, or `frame` is not a number;
- `frame` is lower than that player's last accepted frame;
- `frame` is more than 30 frames ahead of the server clock, or more than 120 frames behind it;
- the player already sent 60 accepted inputs in the last second.

More than 20 rejected messages (including messages over 1 KB or not JSON) close the socket. When a socket closes mid-match the opponent gets `opponentDisconnected`; the player has 15 s to reconnect with `?resume=<token>&ack=<peerAck>` (or to send `resume` on a new socket), or they forfeit. While a slot is free, at most 2 sockets without a resume token may wait to resume (more get `busy`), and each must send `resume` within 5 s (else `resume-timeout`). A socket with a valid token on the upgrade never waits, so other sockets can't block the owner's reconnect. A wrong token gets `error` and the socket is closed. If the missed packets have already left the 100-packet buffer, the server sends `error` with code `resync` instead of a partial replay. If neither player sends a valid message (an accepted input, a ping or a resume) for 60 s after `start`, both engines are run to the server clock: a top-out decides the match, otherwise it ends as a draw with reason `idle`. After `end` the server closes both sockets, and new sockets get `error` (`ended`) and are closed.

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

## Layout

- `src/engine/` — deterministic, headless engine (sub-frame input timing, same as the original)
- `src/server/` — online match and accounts logic (runtime-independent; the Worker in `worker/` wraps each in a Durable Object)
- `src/profile.ts` — records type, validator and merge, shared by the client and the accounts server
- `src/ai/bot.ts` — VS opponent: searches every placement, including soft-drop + spin finishes
- `src/render/` — canvas renderer (board spring physics, particles, action text)
- `src/audio/` — synthesized WebAudio SFX, sound packs and generative music
- `src/ui/` — menus, config, results, session orchestration
- `test/` — engine, bot, match server and accounts tests (vitest)
- `e2e/` — browser runs of 40 LINES and BLITZ (Playwright, `npm run e2e`)
