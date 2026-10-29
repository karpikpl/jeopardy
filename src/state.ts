import { requireCondition as check } from "./commands";
import { expireTimer } from "./timer";
import { Clue, Command, Game, GameData, Phase, SavedState } from "./types";

export function newGame(data: GameData, filename: string, names = ["Contestant 1", "Contestant 2", "Contestant 3"]): Game {
  return {
    data, filename, phase: "setup", round: "jeopardy",
    contestants: names.map((name) => ({ name, score: 0 })), control: 0, used: [], active: null,
    timer: { endsAt: null, expired: false },
    final: { entries: [], answerVisible: false, skipped: false },
    audio: { muted: false, volume: 0.5 }, rulesVisible: false, cue: { sequence: 0, kind: null },
  };
}
export function initialState(data: GameData, filename: string): SavedState {
  return { version: 1, revision: 0, game: newGame(data, filename), history: [], receipts: [] };
}
export function activeClue(game: Game): Clue {
  const clue = game.data[game.round].clues.find((c) => c.id === game.active?.id);
  check(clue, "No active clue.");
  return clue;
}
function phase(game: Game, ...allowed: Phase[]) {
  check(allowed.includes(game.phase), `Action is unavailable during ${game.phase.replaceAll("_", " ")}.`);
}
function contestant(game: Game, index: number) {
  const player = game.contestants[index];
  check(player, "Contestant is not in this game.");
  return player;
}
function cue(game: Game, kind: Game["cue"]["kind"]) {
  game.cue = { sequence: game.cue.sequence + 1, kind };
}
function score(game: Game, index: number, delta: number) {
  const player = contestant(game, index);
  check(Number.isSafeInteger(player.score + delta), "Score exceeds the supported whole-number range.");
  player.score += delta;
}
function clearTimer(game: Game) { game.timer = { endsAt: null, expired: false }; }
function finalEntry(game: Game, index: number) {
  const entry = game.final.entries.find((e) => e.contestant === index);
  check(entry, "Only contestants with positive pre-Final scores can participate.");
  return entry;
}
function judge(game: Game, correct: boolean) {
  phase(game, "clue");
  const active = game.active!;
  check(active.responder !== null, "Select a responder first.");
  check(!active.attempted.includes(active.responder), "This contestant already attempted the clue.");
  const clue = activeClue(game);
  score(game, active.responder, (correct ? 1 : -1) * (clue.dailyDouble ? active.wager! : clue.value));
  active.attempted.push(active.responder);
  if (correct) game.control = active.responder;
  cue(game, correct ? "correct" : "incorrect");
  if (correct || clue.dailyDouble || active.attempted.length === game.contestants.length) {
    game.phase = "resolved";
    clearTimer(game);
  } else active.responder = null;
}
function transition(game: Game, cmd: Command, now: number) {
  switch (cmd.type) {
    case "configure":
      phase(game, "setup");
      game.contestants = cmd.names.map((name) => ({ name: name.trim(), score: 0 }));
      game.control = 0;
      break;
    case "rename": contestant(game, cmd.contestant).name = cmd.name.trim(); break;
    case "start": phase(game, "setup"); game.phase = "board"; break;
    case "control":
      phase(game, "setup", "board");
      contestant(game, cmd.contestant);
      game.control = cmd.contestant;
      break;
    case "select": {
      phase(game, "board");
      const clue = game.data[game.round].clues.find((c) => c.id === cmd.id);
      check(clue && !game.used.includes(clue.id), "Select an unused clue on the current board.");
      game.active = { id: clue.id, responder: clue.dailyDouble ? game.control : null, attempted: [], wager: null, answerVisible: false };
      game.phase = clue.dailyDouble ? "daily_wager" : "clue";
      clearTimer(game);
      cue(game, clue.dailyDouble ? "daily" : "select");
      break;
    }
    case "responder":
      phase(game, "clue");
      check(!activeClue(game).dailyDouble, "Daily Doubles have only one responder.");
      contestant(game, cmd.contestant);
      check(!game.active!.attempted.includes(cmd.contestant), "This contestant already attempted the clue.");
      game.active!.responder = cmd.contestant;
      break;
    case "judge": judge(game, cmd.correct); break;
    case "no_answer":
      phase(game, "clue");
      if (activeClue(game).dailyDouble) judge(game, false);
      else { game.phase = "resolved"; clearTimer(game); }
      break;
    case "reveal_answer":
      phase(game, "clue", "resolved", "final_judging");
      if (game.phase === "final_judging") {
        check(!game.final.answerVisible, "Answer is already visible.");
        game.final.answerVisible = true;
      } else {
        check(!game.active!.answerVisible, "Answer is already visible.");
        if (game.phase === "clue" && activeClue(game).dailyDouble) judge(game, false);
        game.active!.answerVisible = true;
        game.phase = "resolved";
        clearTimer(game);
      }
      cue(game, "reveal");
      break;
    case "return_board":
      phase(game, "resolved");
      game.used.push(game.active!.id);
      game.active = null;
      game.phase = "board";
      clearTimer(game);
      break;
    case "daily_wager": {
      phase(game, "daily_wager");
      const player = contestant(game, cmd.contestant);
      const max = Math.max(player.score, game.round === "jeopardy" ? 1000 : 2000);
      check(cmd.amount >= 5 && cmd.amount <= max, `Daily Double wager must be 5–${max}.`);
      game.active!.responder = cmd.contestant;
      game.active!.wager = cmd.amount;
      game.control = cmd.contestant;
      game.phase = "clue";
      cue(game, "select");
      break;
    }
    case "advance":
      phase(game, "board");
      check(cmd.confirmed || game.data[game.round].clues.every((c) => game.used.includes(c.id)),
        "Confirm skipping the remaining clues.");
      if (game.round === "jeopardy") {
        const low = Math.min(...game.contestants.map((c) => c.score));
        const choices = game.contestants.map((c, i) => c.score === low ? i : -1).filter((i) => i !== -1);
        const control = cmd.contestant ?? (choices.length === 1 ? choices[0] : undefined);
        check(control !== undefined && choices.includes(control), "Choose a lowest-scoring contestant to start Double Jeopardy.");
        game.control = control;
        game.round = "double_jeopardy";
      } else {
        game.final.entries = game.contestants.flatMap((c, i) => c.score > 0 ?
          [{ contestant: i, score: c.score, wager: null, correct: null, revealed: false }] : [])
          .sort((a, b) => a.score - b.score || a.contestant - b.contestant);
        game.final.skipped = game.final.entries.length === 0;
        game.phase = game.final.skipped ? "finished" : "final_wagers";
      }
      break;
    case "final_wager": {
      phase(game, "final_wagers");
      const entry = finalEntry(game, cmd.contestant);
      check(cmd.amount >= 0 && cmd.amount <= entry.score, `Final wager must be 0–${entry.score}.`);
      entry.wager = cmd.amount;
      break;
    }
    case "lock_wagers":
      phase(game, "final_wagers");
      check(game.final.entries.every((e) => e.wager !== null), "Record every eligible contestant's wager.");
      game.phase = "final_clue";
      cue(game, "select");
      break;
    case "start_timer":
      phase(game, "clue", "final_clue");
      check(game.timer.endsAt === null && !game.timer.expired, "This clue's timer has already started.");
      game.timer = { endsAt: now + (game.phase === "final_clue" ? 30 : (cmd.seconds ?? 10)) * 1000, expired: false };
      if (game.phase === "final_clue") game.phase = "final_thinking";
      break;
    case "final_judge": {
      phase(game, "final_judging");
      const entry = finalEntry(game, cmd.contestant);
      check(!entry.revealed, "Undo a reveal before changing its judgment.");
      entry.correct = cmd.correct;
      break;
    }
    case "final_reveal": {
      phase(game, "final_judging");
      const entry = game.final.entries.find((e) => !e.revealed);
      check(entry, "All Final results are already revealed.");
      check(entry.correct !== null, "Judge the next contestant before revealing.");
      score(game, entry.contestant, (entry.correct ? 1 : -1) * entry.wager!);
      entry.revealed = true;
      cue(game, entry.correct ? "correct" : "incorrect");
      break;
    }
    case "finish":
      phase(game, "final_judging");
      check(game.final.entries.every((e) => e.revealed), "Reveal all Final results before finishing.");
      game.phase = "finished";
      break;
    case "adjust_score":
      check(!["final_clue", "final_thinking", "final_judging", "finished"].includes(game.phase),
        "Undo back before locked Final wagers to adjust scores.");
      check(game.phase !== "final_wagers", "Undo back to the board before changing pre-Final scores.");
      score(game, cmd.contestant, cmd.delta);
      break;
    case "audio": game.audio = { muted: cmd.muted, volume: cmd.volume }; break;
    case "rules": game.rulesVisible = cmd.visible; break;
    case "undo": case "reset": case "select_csv": throw new Error("Command requires the state controller.");
  }
}

export function applyCommand(
  source: SavedState, cmd: Command, id: string, now: number,
  replacement?: { data: GameData; filename: string },
): SavedState {
  const next = structuredClone(source);
  if (cmd.type === "undo") {
    const previous = next.history.pop();
    check(previous, "Nothing to undo.");
    const current = next.game;
    const finalPhases = ["final_clue", "final_thinking", "final_judging"];
    const sameTimerScope = (current.active && previous.active && current.active.id === previous.active.id) ||
      (finalPhases.includes(current.phase) && finalPhases.includes(previous.phase));
    if (sameTimerScope && previous.timer.endsAt === null && (current.timer.endsAt !== null || current.timer.expired)) {
      previous.timer = { ...current.timer };
      if (previous.phase === "final_clue") previous.phase = current.timer.expired ? "final_judging" : "final_thinking";
    }
    previous.audio = next.game.audio;
    previous.rulesVisible = next.game.rulesVisible ?? false;
    previous.cue = { sequence: next.game.cue.sequence, kind: null };
    next.game = previous;
    expireTimer(next.game, now);
  } else if (cmd.type === "reset" || cmd.type === "select_csv") {
    check(cmd.confirmed, "Confirm starting a new game.");
    if (cmd.type === "select_csv") check(replacement, "CSV replacement is missing.");
    const game = next.game;
    next.game = newGame(replacement?.data ?? game.data, replacement?.filename ?? game.filename,
      game.contestants.map((c) => c.name));
    next.game.audio = game.audio;
    next.game.rulesVisible = game.rulesVisible ?? false;
    next.game.cue = { sequence: game.cue.sequence, kind: null };
    next.history = [];
  } else {
    if (cmd.type !== "audio" && cmd.type !== "rules") next.history.push(structuredClone(next.game));
    transition(next.game, cmd, now);
  }
  next.revision++;
  next.receipts.push(id);
  return next;
}
