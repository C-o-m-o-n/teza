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

## Deploy

Every push to `main` deploys to Cloudflare Workers through `.github/workflows/deploy.yml`. It runs `npm ci` and `npm run check`, then `wrangler deploy` publishes `dist/` as static assets plus the game server Worker (see `wrangler.jsonc`), and the job checks that `/` and `/game.js` load from the deployed URL.

The workflow needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission on the account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

To deploy by hand, run `npm run build`, then `npx wrangler deploy`.

Live URL: https://teza.comon928.workers.dev/

## Game server

The `teza` Worker (`worker/index.ts`) serves `dist/` as static assets. Only `/api/*` runs the script:

- `GET /api/match/<id>` with `Upgrade: websocket` joins match `<id>`. Each id gets its own `Match` Durable Object, which holds both sockets and runs one headless engine per player. `<id>` must match `^[A-Za-z0-9_-]{1,32}$` (else 400). Without the upgrade header the route returns 426.
- Any other `/api/*` path returns 404.

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
| `end` | `{winner, reason}`: reason is `topout` or `disconnect`; sent once |
| `error` | `{code, message}` |
| `pong` | none |

| Client to server | `d` |
|---|---|
| `input` | `{frame, action, kind}`: action is `left right soft hard cw ccw 180 hold`, kind is `press` or `release` |
| `resume` | `{token, peerAck}`: rebind a slot on a new socket, then get the missed packets with `s > peerAck` |
| `ping` | anything; answered with `pong` |

The first two sockets take slots 0 and 1, and the match starts when both are connected. A third socket gets `error` (`full`) and is closed. If no second player joins within 2 minutes, the first gets `error` (`no-opponent`), its socket is closed and the match id starts fresh.

There is no server tick. Engines advance when a message arrives: a player's engine moves to the frame of each input it accepts, and any engine more than 120 frames behind the server clock (ms since `start` × 60 / 1000) is first moved up to that limit, as if the player pressed nothing. A player who goes quiet therefore keeps falling and can still top out. An input is rejected with `error` and leaves the engine alone when:

- the action or kind is unknown, or `frame` is not a number;
- `frame` is lower than that player's last accepted frame;
- `frame` is more than 30 frames ahead of the server clock, or more than 120 frames behind it;
- the player already sent 60 accepted inputs in the last second.

More than 20 rejected messages (including messages over 1 KB or not JSON) close the socket. When a socket closes mid-match the opponent gets `opponentDisconnected`; the player has 15 s to send `resume` with their token on a new socket, or they forfeit. While a slot is free, at most 2 new sockets may wait to resume (more get `busy`), and each must send `resume` within 5 s (else `resume-timeout`). A wrong token gets `error` and the socket is closed. If the missed packets have already left the 100-packet buffer, the server sends `error` with code `resync` instead of a partial replay. After `end` the server closes both sockets, and new sockets get `error` (`ended`) and are closed.

## Controls (TETR.IO defaults, rebindable in CONFIG)

| Action | Keys |
|---|---|
| Move | ← → |
| Soft / hard drop | ↓ / Space |
| Rotate CW / CCW / 180 | ↑ or X / Z or Ctrl / A |
| Hold | C or Shift |
| Retry / Menu | R / Esc |

## Layout

- `src/engine/` — deterministic, headless engine (sub-frame input timing, same as the original)
- `src/server/` — online match logic (runtime-independent; the Worker in `worker/` wraps it in a Durable Object)
- `src/ai/bot.ts` — VS opponent: searches every placement, including soft-drop + spin finishes
- `src/render/` — canvas renderer (board spring physics, particles, action text)
- `src/audio/` — synthesized WebAudio SFX
- `src/ui/` — menus, config, results, session orchestration
- `test/` — engine, bot and match server tests (vitest)
