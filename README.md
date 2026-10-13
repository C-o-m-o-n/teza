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

Every push to `main` deploys to Cloudflare Workers through `.github/workflows/deploy.yml`. It runs `npm ci` and `npm run check`, then `wrangler deploy` publishes `dist/` as an assets-only Worker (see `wrangler.jsonc`), and the job checks that `/` and `/game.js` load from the deployed URL.

The workflow needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission on the account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

To deploy by hand, run `npm run build`, then `npx wrangler deploy`.

Live URL: https://teza.comon928.workers.dev/

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
- `src/ai/bot.ts` — VS opponent: searches every placement, including soft-drop + spin finishes
- `src/render/` — canvas renderer (board spring physics, particles, action text)
- `src/audio/` — synthesized WebAudio SFX
- `src/ui/` — menus, config, results, session orchestration
- `test/` — engine and bot tests (vitest)
