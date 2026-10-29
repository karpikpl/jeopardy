const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseBoard, loadBoard } = require("../dist/csv");
const { initialState, applyCommand } = require("../dist/state");
const { displayState, adminState } = require("../dist/projection");
const { expireTimer } = require("../dist/timer");
const { validateEnvelope } = require("../dist/commands");
const { assertSavedState, Store } = require("../dist/persist");

const raw = fs.readFileSync(path.join(__dirname, "../boards.template.csv"), "utf8");
const data = parseBoard(raw);
function ready() {
  let state = initialState(structuredClone(data), "boards.template.csv");
  let n = 0;
  return {
    get state() { return state; },
    get game() { return state.game; },
    act(command, now = 1000) { state = applyCommand(state, command, `id-${++n}`, now); return state; },
    set state(value) { state = value; },
  };
}
function selected(daily = false) {
  const ctx = ready();
  ctx.act({ type: "start" });
  const clue = ctx.game.data.jeopardy.clues.find((c) => c.dailyDouble === daily);
  ctx.act({ type: "select", id: clue.id });
  return { ctx, clue };
}
function finalReady(scores = [1000, 2000, -200]) {
  const ctx = ready();
  ctx.act({ type: "start" });
  scores.forEach((delta, contestant) => ctx.act({ type: "adjust_score", contestant, delta }));
  ctx.act({ type: "advance", confirmed: true, contestant: scores.indexOf(Math.min(...scores)) });
  ctx.act({ type: "advance", confirmed: true });
  return ctx;
}
test("CSV produces a complete game, stable IDs and explicit Daily Doubles", () => {
  assert.equal(data.jeopardy.clues.length, 30);
  assert.equal(data.double_jeopardy.clues.length, 30);
  assert.equal(data.final.value, 0);
  assert.equal(data.jeopardy.clues.filter((c) => c.dailyDouble).length, 1);
  assert.equal(data.double_jeopardy.clues.filter((c) => c.dailyDouble).length, 2);
  assert.deepEqual(parseBoard("\uFEFF" + raw.replace("round,category", " ROUND , CATEGORY ")), data);
  assert.equal(data.jeopardy.clues[0].id, "jeopardy:0:200");
  const quoted = raw.replace("Our home planet is the third one from the Sun.", '"A ""quoted"",\nmultiline clue."');
  assert.equal(parseBoard(quoted).jeopardy.clues[0].clue, 'A "quoted",\nmultiline clue.');
});
test("CSV rejects invalid content instead of silently dropping or defaulting rows", () => {
  assert.throws(() => parseBoard(raw.replace("round,category", "round,round")), /headers/);
  assert.throws(() => parseBoard(raw.replace("SPACE,200", "SPACE,201")), /record 2.*value/);
  assert.throws(() => parseBoard(raw.replace("SPACE,200", "SPACE,400")), /duplicate/);
  assert.throws(() => parseBoard(raw.replace("SPACE,200,", ",200,")), /must not be empty/);
  assert.throws(() => parseBoard(raw.replace(",false", ",yes")), /daily_double/);
  assert.throws(() => parseBoard(raw.replace(",true", ",false")), /Daily Double/);
  assert.throws(() => parseBoard(raw.replace("jeopardy,SPACE", "other,SPACE")), /unknown round/);
  assert.throws(() => parseBoard(raw.split("\n").filter((line) => !line.startsWith("final,")).join("\n")), /Final/);
  assert.throws(() => parseBoard(raw.replace("final,GEOGRAPHY,,", "final,GEOGRAPHY,200,")), /blank value/);
  assert.throws(() => parseBoard(raw.split("\n").filter((line) => !line.startsWith("jeopardy,SPACE,200")).join("\n")), /six categories/);
  assert.throws(() => loadBoard(path.join(__dirname, ".."), "../familyfeud/questions.template.csv"), /server's list/);
});
test("regular clues support rebounds, negative scores and exactly-once judgment", () => {
  const { ctx, clue } = selected();
  ctx.act({ type: "responder", contestant: 0 });
  ctx.act({ type: "judge", correct: false });
  assert.equal(ctx.game.contestants[0].score, -clue.value);
  assert.equal(ctx.game.phase, "clue");
  assert.throws(() => ctx.act({ type: "responder", contestant: 0 }), /already attempted/);
  ctx.act({ type: "responder", contestant: 1 });
  ctx.act({ type: "judge", correct: true });
  assert.equal(ctx.game.control, 1);
  assert.equal(ctx.game.contestants[1].score, clue.value);
  assert.throws(() => ctx.act({ type: "judge", correct: true }), /unavailable/);
  ctx.act({ type: "reveal_answer" });
  ctx.act({ type: "return_board" });
  assert.throws(() => ctx.act({ type: "select", id: clue.id }), /unused clue/);
});
test("all-wrong, no-answer and reveal stop scoring without additional deductions", () => {
  const { ctx, clue } = selected();
  for (let i = 0; i < 3; i++) {
    ctx.act({ type: "responder", contestant: i });
    ctx.act({ type: "judge", correct: false });
  }
  assert.equal(ctx.game.phase, "resolved");
  assert.deepEqual(ctx.game.contestants.map((c) => c.score), [-clue.value, -clue.value, -clue.value]);
  for (const action of ["no_answer", "reveal_answer"]) {
    const { ctx: next } = selected();
    next.act({ type: action });
    assert.equal(next.game.phase, "resolved");
    assert.deepEqual(next.game.contestants.map((c) => c.score), [0, 0, 0]);
  }
});
test("Daily Double hides clue before wager, validates bounds and has no rebound", () => {
  const { ctx, clue } = selected(true);
  let publicState = displayState(ctx.state);
  assert.equal(publicState.active.clue, undefined);
  assert.equal(publicState.active.answer, undefined);
  assert.throws(() => ctx.act({ type: "daily_wager", contestant: 0, amount: 4 }), /5–1000/);
  assert.throws(() => ctx.act({ type: "daily_wager", contestant: 0, amount: 1001 }), /5–1000/);
  ctx.act({ type: "daily_wager", contestant: 0, amount: 1000 });
  assert.equal(displayState(ctx.state).active.clue, clue.clue);
  assert.throws(() => ctx.act({ type: "responder", contestant: 1 }), /one responder/);
  ctx.act({ type: "no_answer" });
  assert.equal(ctx.game.contestants[0].score, -1000);
  assert.equal(ctx.game.phase, "resolved");
  const correct = selected(true).ctx;
  correct.act({ type: "daily_wager", contestant: 1, amount: 5 });
  correct.act({ type: "judge", correct: true });
  assert.equal(correct.game.contestants[1].score, 5);
});
test("round transitions require confirmation and lowest-score control", () => {
  const ctx = ready();
  assert.throws(() => ctx.act({ type: "configure", names: ["a", "b"] }) && ctx.act({ type: "advance", confirmed: true }), /unavailable/);
  ctx.act({ type: "start" });
  assert.throws(() => ctx.act({ type: "advance", confirmed: false }), /Confirm/);
  assert.throws(() => ctx.act({ type: "advance", confirmed: true }), /lowest-scoring/);
  ctx.act({ type: "advance", confirmed: true, contestant: 1 });
  assert.equal(ctx.game.round, "double_jeopardy");
  assert.equal(ctx.game.control, 1);
  ctx.act({ type: "undo" });
  assert.equal(ctx.game.round, "jeopardy");
});
test("Final gates eligibility and private wagers, then reveals scores exactly once", () => {
  const ctx = finalReady();
  assert.deepEqual(ctx.game.final.entries.map((e) => e.contestant), [0, 1]);
  assert.throws(() => ctx.act({ type: "final_wager", contestant: 2, amount: 0 }), /positive/);
  assert.throws(() => ctx.act({ type: "final_wager", contestant: 0, amount: 1001 }), /0–1000/);
  assert.throws(() => ctx.act({ type: "lock_wagers" }), /every eligible/);
  ctx.act({ type: "final_wager", contestant: 0, amount: 0 });
  ctx.act({ type: "final_wager", contestant: 1, amount: 2000 });
  assert.ok(displayState(ctx.state).final.entries.every((e) => e.wager === undefined));
  assert.equal(displayState(ctx.state).final.clue, undefined);
  ctx.act({ type: "lock_wagers" });
  assert.equal(displayState(ctx.state).final.clue, data.final.clue);
  assert.throws(() => ctx.act({ type: "adjust_score", contestant: 0, delta: 1 }), /Undo/);
  ctx.act({ type: "start_timer" }, 1000);
  assert.equal(ctx.game.timer.endsAt, 31000);
  assert.throws(() => ctx.act({ type: "final_judge", contestant: 0, correct: true }), /unavailable/);
  assert.equal(expireTimer(ctx.game, 30999), false);
  assert.equal(expireTimer(ctx.game, 31000), true);
  ctx.act({ type: "final_judge", contestant: 0, correct: true }, 31000);
  ctx.act({ type: "final_judge", contestant: 1, correct: false }, 31000);
  assert.ok(displayState(ctx.state).final.entries.every((e) => e.correct === undefined));
  ctx.act({ type: "final_reveal" }, 31000);
  assert.equal(displayState(ctx.state).final.entries[0].wager, 0);
  assert.equal(displayState(ctx.state).final.entries[1].wager, undefined);
  assert.throws(() => ctx.act({ type: "finish" }, 31000), /Reveal all/);
  ctx.act({ type: "final_reveal" }, 31000);
  assert.equal(ctx.game.contestants[1].score, 0);
  assert.throws(() => ctx.act({ type: "final_reveal" }, 31000), /already revealed/);
  ctx.act({ type: "reveal_answer" }, 31000);
  ctx.act({ type: "finish" }, 31000);
  assert.deepEqual(displayState(ctx.state).winners, [0]);
});
test("Final ties and no eligible contestants have explicit results", () => {
  const ctx = finalReady([0, 0, -1]);
  assert.equal(ctx.game.phase, "finished");
  assert.equal(ctx.game.final.skipped, true);
  assert.deepEqual(displayState(ctx.state).winners, [0, 1]);
  const tie = finalReady([100, 100, -1]);
  for (const contestant of [0, 1]) tie.act({ type: "final_wager", contestant, amount: 100 });
  tie.act({ type: "lock_wagers" });
  tie.act({ type: "start_timer" }, 0);
  expireTimer(tie.game, 30000);
  for (const contestant of [0, 1]) {
    tie.act({ type: "final_judge", contestant, correct: false }, 30000);
    tie.act({ type: "final_reveal" }, 30000);
  }
  tie.act({ type: "finish" }, 30000);
  assert.deepEqual(displayState(tie.state).winners, [0, 1]);
});
test("timer, undo and reset preserve durable protocol metadata without gifting time", () => {
  const { ctx } = selected();
  ctx.act({ type: "start_timer", seconds: 5 }, 1000);
  ctx.act({ type: "responder", contestant: 0 }, 2000);
  const revision = ctx.state.revision;
  ctx.act({ type: "undo" }, 7000);
  assert.equal(ctx.game.timer.expired, true);
  assert.equal(ctx.game.timer.endsAt, null);
  assert.equal(ctx.state.revision, revision + 1);
  assert.equal(ctx.state.receipts.length, revision + 1);
  assert.throws(() => ctx.act({ type: "start_timer" }), /already started/);
  ctx.act({ type: "audio", muted: true, volume: .2 });
  ctx.act({ type: "rename", contestant: 0, name: "Team Alpha" });
  ctx.act({ type: "reset", confirmed: true });
  assert.equal(ctx.game.contestants[0].name, "Team Alpha");
  assert.equal(ctx.game.audio.muted, true);
  assert.equal(ctx.state.history.length, 0);
  assert.throws(() => ctx.act({ type: "undo" }), /Nothing/);
});
test("undoing timer start cannot restart the same expired Final clock", () => {
  const ctx = finalReady();
  for (const contestant of [0, 1]) ctx.act({ type: "final_wager", contestant, amount: 0 });
  ctx.act({ type: "lock_wagers" });
  ctx.act({ type: "start_timer" }, 1000);
  expireTimer(ctx.game, 31000);
  ctx.act({ type: "undo" }, 32000);
  assert.equal(ctx.game.phase, "final_judging");
  assert.equal(ctx.game.timer.expired, true);
  assert.throws(() => ctx.act({ type: "start_timer" }, 32000), /unavailable/);
});
test("public state omits private banks, answers, DD locations, wagers and history", () => {
  const { ctx } = selected();
  const pub = displayState(ctx.state, 1000);
  assert.equal(pub.serverTime, 1000);
  const json = JSON.stringify(pub);
  assert.ok(!json.includes(data.final.clue));
  assert.ok(!json.includes(data.final.answer));
  assert.ok(!json.includes('"history"'));
  assert.ok(!json.includes('"dailyClues"'));
  assert.ok(!json.includes('"answer"'));
  assert.ok(!json.includes('"data"'));
  assert.equal(adminState(ctx.state).private.answer, data.jeopardy.clues[0].answer);
});
test("runtime validation rejects malformed and unknown commands", () => {
  const wrap = (command) => ({ id: "test-1", revision: 0, command });
  for (const command of [
    { type: "judge", correct: "true" }, { type: "daily_wager", contestant: 0, amount: 1.5 },
    { type: "audio", muted: false, volume: NaN }, { type: "configure", names: ["a"] },
    { type: "configure", names: ["a", ""] }, { type: "select_csv", filename: "", confirmed: true },
    { type: "start_timer", seconds: 0 }, { type: "unknown" }, null,
    { type: "rules", visible: "true" },
  ]) assert.throws(() => validateEnvelope(wrap(command)));
  assert.throws(() => validateEnvelope({ ...wrap({ type: "start" }), id: "<bad>" }));
  assert.deepEqual(validateEnvelope(wrap({ type: "start" })).command, { type: "start" });
});
test("saved-state schema rejects corruption and validates game history", () => {
  const { ctx } = selected();
  assertSavedState(JSON.parse(JSON.stringify(ctx.state)));
  const bad = structuredClone(ctx.state);
  bad.game.contestants[0].score = "100";
  assert.throws(() => assertSavedState(bad), /contestants/);
  assert.throws(() => assertSavedState({ version: 2 }), /Unsupported/);
  const broken = structuredClone(ctx.state);
  broken.history[0].data.final.answer = null;
  assert.throws(() => assertSavedState(broken), /clue fields/);
});

test("rules are presentation-only, preserve undo and timers, and survive undo/reset", () => {
  const { ctx } = selected();
  ctx.act({ type: "start_timer", seconds: 30 });
  ctx.act({ type: "responder", contestant: 0 });
  for (const context of [ctx, selected(true).ctx, finalReady()]) {
    const before = structuredClone(context.state);
    for (const visible of [true, false, true]) {
      context.act({ type: "rules", visible });
      assert.equal(context.game.rulesVisible, visible);
      assert.deepEqual({ ...context.game, rulesVisible: before.game.rulesVisible }, before.game);
      assert.deepEqual(context.state.history, before.history);
    }
    context.act({ type: "undo" });
    assert.equal(context.game.rulesVisible, true);
    context.act({ type: "reset", confirmed: true });
    assert.equal(context.game.rulesVisible, true);
    assert.equal(context.state.history.length, 0);
    context.act({ type: "rules", visible: false });
    assert.equal(context.state.history.length, 0);
    assert.throws(() => context.act({ type: "undo" }), /Nothing/);
  }
});

test("legacy games and undo snapshots load without rules visibility; toggles persist", () => {
  const { ctx } = selected();
  const legacy = structuredClone(ctx.state);
  delete legacy.game.rulesVisible;
  for (const game of legacy.history) delete game.rulesVisible;
  const store = new Store(":memory:");
  try {
    store.save(legacy);
    ctx.state = store.load();
    assert.equal(displayState(ctx.state).rulesVisible, false);
    assert.equal(adminState(ctx.state).rulesVisible, false);
    ctx.act({ type: "rules", visible: true });
    store.save(ctx.state);
    ctx.state = store.load();
    assert.equal(ctx.game.rulesVisible, true);
    ctx.act({ type: "undo" });
    assert.equal(ctx.game.rulesVisible, true);
    const bad = structuredClone(legacy);
    bad.game.rulesVisible = "yes";
    assert.throws(() => assertSavedState(bad), /rules visibility/);
  } finally { store.close(); }
});
