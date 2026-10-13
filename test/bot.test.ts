import { describe, expect, it } from "vitest";
import { Bot, BOT_PROFILES } from "../src/ai/bot";
import { Game } from "../src/engine/game";

describe("bot", () => {
  it("survives 150 pieces and sends attack", () => {
    const g = new Game({ seed: 7, hasgarbage: true });
    const bot = new Bot(g, BOT_PROFILES[3]);
    for (let i = 0; i < 150 && !g.over; i++) bot.playPiece();
    console.log("bot stats", { pieces: g.stats.pieces, lines: g.stats.lines, attack: g.stats.attack, clears: g.stats.clears });
    expect(g.over).toBe(false);
    expect(g.stats.attack).toBeGreaterThan(30);
  }, 30000);
});
