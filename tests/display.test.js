const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBoard } = require("../dist/csv");
const { initialState, applyCommand } = require("../dist/state");
const { displayState } = require("../dist/projection");

function display() {
  const nodes = new Map();
  const handlers = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        writes: 0,
        set innerHTML(html) { this.html = html; this.writes++; },
        style: { setProperty() {} },
        setAttribute() {},
        addEventListener() {},
      });
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/display/app.js"), "utf8"), {
    document,
    io: () => ({ on: (event, handler) => handlers.set(event, handler) }),
    window: { addEventListener() {} },
    requestAnimationFrame: (callback) => callback(),
    setInterval() {},
    GameRules: "Shared game rules",
  });
  return {
    update: (state) => handlers.get("state")(displayState(state)),
    screen: nodes.get("screen"),
    podiums: nodes.get("podiums"),
    rules: nodes.get("rules"),
  };
}

test("responder and scoring updates preserve the TV clue while scores still update", () => {
  const data = loadBoard(path.join(__dirname, ".."), "boards.template.csv");
  let state = initialState(data, "boards.template.csv");
  const tv = display();
  let sequence = 0;
  const send = (command) => {
    state = applyCommand(state, command, `display-${++sequence}`, Date.now());
    tv.update(state);
  };
  send({ type: "start" });
  send({ type: "select", id: data.jeopardy.clues[0].id });
  const clueWrites = tv.screen.writes;
  const podiumWrites = tv.podiums.writes;
  send({ type: "responder", contestant: 0 });
  assert.equal(tv.screen.writes, clueWrites);
  assert.equal(tv.podiums.writes, podiumWrites);
  send({ type: "judge", correct: false });
  assert.equal(tv.screen.writes, clueWrites);
  assert.match(tv.podiums.html, /−\$200/);
  send({ type: "responder", contestant: 1 });
  send({ type: "judge", correct: true });
  assert.equal(tv.screen.writes, clueWrites);
  assert.match(tv.podiums.html, /class="score ">\$200/);
  send({ type: "undo" });
  assert.equal(tv.screen.writes, clueWrites);
  send({ type: "reveal_answer" });
  assert.equal(tv.screen.writes, clueWrites + 1);
  assert.ok(tv.screen.html.includes(data.jeopardy.clues[0].answer));
  send({ type: "return_board" });
  assert.match(tv.screen.html, /class="board"/);
});

test("Daily Double wager prompts update when the contestant is renamed", () => {
  const data = loadBoard(path.join(__dirname, ".."), "boards.template.csv");
  let state = initialState(data, "boards.template.csv");
  state = applyCommand(state, { type: "start" }, "start", Date.now());
  state = applyCommand(state, { type: "select", id: data.jeopardy.clues.find((c) => c.dailyDouble).id }, "select", Date.now());
  const tv = display();
  tv.update(state);
  state = applyCommand(state, { type: "rename", contestant: state.game.control, name: "New name" }, "rename", Date.now());
  tv.update(state);
  assert.match(tv.screen.html, /New name, make your wager/);
});

test("rules cover the TV without recreating the clue or rules on snapshot updates", () => {
  const data = loadBoard(path.join(__dirname, ".."), "boards.template.csv");
  let state = initialState(data, "boards.template.csv");
  const tv = display();
  let id = 0;
  const send = (command) => {
    state = applyCommand(state, command, `rules-${++id}`, Date.now());
    tv.update(state);
  };
  send({ type: "start" });
  send({ type: "select", id: data.jeopardy.clues[0].id });
  const writes = tv.screen.writes;
  send({ type: "rules", visible: true });
  assert.equal(tv.rules.hidden, false);
  send({ type: "responder", contestant: 0 });
  send({ type: "audio", muted: true, volume: .5 });
  send({ type: "rules", visible: false });
  assert.equal(tv.rules.hidden, true);
  assert.equal(tv.screen.writes, writes);
  assert.equal(tv.rules.writes, 1);
});
