import { activeClue } from "./state";
import { AdminState, DisplayState, SavedState } from "./types";
import { clueImageUrl } from "./images";

export function displayState(saved: SavedState, now = Date.now()): DisplayState {
  const game = saved.game;
  const finalPhase = game.phase.startsWith("final_") || game.phase === "finished";
  const finalClueVisible = finalPhase && game.phase !== "final_wagers" && !game.final.skipped;
  const candidates = game.final.entries.length ? game.final.entries.map((e) => e.contestant) :
    game.contestants.map((_, i) => i);
  const high = Math.max(...candidates.map((i) => game.contestants[i].score));
  const clue = game.active ? activeClue(game) : null;
  return {
    revision: saved.revision, serverTime: now, filename: game.filename, phase: game.phase, round: game.round,
    contestants: game.contestants.map((c) => ({ ...c })), control: game.control,
    board: game.data[game.round].categories.map((category) => ({
      category,
      cells: game.data[game.round].clues.filter((c) => c.category === category)
        .sort((a, b) => a.value - b.value).map((c) => ({ id: c.id, value: c.value, used: game.used.includes(c.id) })),
    })),
    active: clue && game.active ? {
      category: clue.category, value: clue.value, dailyDouble: clue.dailyDouble,
      responder: game.active.responder,
      ...(game.phase !== "daily_wager" ? { clue: clue.clue } : {}),
      ...(game.phase !== "daily_wager" && clue.image ? { imageUrl: clueImageUrl(game.filename, clue) } : {}),
      ...(game.active.answerVisible ? { answer: clue.answer } : {}),
      ...(game.active.wager !== null ? { wager: game.active.wager } : {}),
    } : null,
    final: {
      category: finalPhase ? game.data.final.category : null,
      ...(finalClueVisible ? { clue: game.data.final.clue } : {}),
      ...(finalClueVisible && game.data.final.image ? { imageUrl: clueImageUrl(game.filename, game.data.final) } : {}),
      ...(game.final.answerVisible ? { answer: game.data.final.answer } : {}),
      entries: game.final.entries.map((e) => ({
        contestant: e.contestant, revealed: e.revealed,
        ...(e.revealed ? { wager: e.wager!, correct: e.correct! } : {}),
      })),
      skipped: game.final.skipped,
    },
    winners: game.phase === "finished" ? candidates.filter((i) => game.contestants[i].score === high) : [],
    timer: { ...game.timer }, audio: { ...game.audio }, rulesVisible: game.rulesVisible ?? false, cue: { ...game.cue },
  };
}
export function adminState(saved: SavedState, now = Date.now()): AdminState {
  const game = saved.game;
  return {
    ...displayState(saved, now), canUndo: saved.history.length > 0,
    private: {
      answer: game.active ? activeClue(game).answer :
        game.phase.startsWith("final_") ? game.data.final.answer : null,
      attempted: game.active ? [...game.active.attempted] : [],
      daily: !!game.active && activeClue(game).dailyDouble,
      finalEntries: structuredClone(game.final.entries),
      dailyClues: game.data[game.round].clues.filter((c) => c.dailyDouble).map((c) => c.id),
    },
  };
}
