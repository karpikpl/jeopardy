import { Game } from "./types";

export function expireTimer(game: Game, now: number): boolean {
  if (game.timer.endsAt === null || now < game.timer.endsAt) return false;
  game.timer = { endsAt: null, expired: true };
  if (game.phase === "final_thinking") game.phase = "final_judging";
  game.cue = { sequence: game.cue.sequence + 1, kind: "time" };
  return true;
}
