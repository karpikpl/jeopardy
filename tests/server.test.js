const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { io } = require("socket.io-client");
const { startServer } = require("../dist/server");
const { Store } = require("../dist/persist");
const { loadBoard } = require("../dist/csv");
const { initialState } = require("../dist/state");

const root = path.join(__dirname, "..");
async function connect(port) {
  const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false, transports: ["websocket"], reconnection: false });
  let state;
  socket.on("state", (s) => { state = s; });
  const first = once(socket, "state");
  socket.connect();
  await first;
  return { socket, get state() { return state; } };
}
let counter = 0;
function send(client, command, overrides = {}) {
  return client.socket.timeout(3000).emitWithAck("cmd", {
    id: `test-${++counter}`, revision: client.state.revision, command, ...overrides,
  });
}
class MemoryStore {
  constructor(state) { this.state = state; this.fail = false; }
  load() { return structuredClone(this.state); }
  save(state) {
    if (this.fail) throw new Error("Simulated disk failure");
    this.state = structuredClone(state);
  }
  close() {}
}
function seededStore() { return new MemoryStore(initialState(loadBoard(root, "boards.template.csv"), "boards.template.csv")); }

test("dual servers isolate secrets, reject bad/stale commands and prevent duplicate scores across restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeopardy-test-"));
  const dbPath = path.join(dir, "game.db");
  let server = await startServer({ root, dbPath, displayPort: 0, adminPort: 0 });
  let admin = await connect(server.adminPort);
  let tv = await connect(server.displayPort);
  t.after(async () => { admin.socket.disconnect(); tv.socket.disconnect(); await server.close(); fs.rmSync(dir, { recursive: true }); });
  for (const [port, role] of [[server.displayPort, "display"], [server.adminPort, "admin"]]) {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true, role });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  }
  assert.ok(admin.state.private);
  assert.equal(tv.state.private, undefined);
  tv.socket.emit("cmd", { id: "display-write", revision: 0, command: { type: "start" } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(admin.state.phase, "setup");
  assert.equal((await send(admin, { type: "judge", correct: "true" })).ok, false);
  assert.equal((await send(admin, { type: "start" })).ok, true);
  assert.equal((await send(admin, { type: "reset", confirmed: true }, { revision: 0 })).ok, false);
  const clue = admin.state.board[0].cells[0];
  await send(admin, { type: "select", id: clue.id });
  await send(admin, { type: "responder", contestant: 0 });
  const command = { type: "judge", correct: true };
  const envelope = { id: "scoring-once", revision: admin.state.revision };
  assert.equal((await send(admin, command, envelope)).ok, true);
  const score = admin.state.contestants[0].score;
  assert.equal((await send(admin, command, envelope)).duplicate, true);
  assert.equal(admin.state.contestants[0].score, score);
  assert.equal((await send(admin, { type: "select_csv", filename: "../familyfeud/questions.template.csv", confirmed: true })).ok, false);
  assert.equal(admin.state.contestants[0].score, score);
  admin.socket.disconnect(); tv.socket.disconnect(); await server.close();
  server = await startServer({ root, dbPath, displayPort: 0, adminPort: 0 });
  admin = await connect(server.adminPort); tv = await connect(server.displayPort);
  assert.equal(admin.state.phase, "resolved");
  assert.equal(admin.state.contestants[0].score, score);
  assert.equal((await send(admin, command, envelope)).duplicate, true);
  assert.equal((await send(admin, { type: "undo" })).ok, true);
  assert.equal(admin.state.contestants[0].score, 0);
  assert.equal(admin.state.phase, "clue");
});
test("failed persistence does not publish candidate state or success", async (t) => {
  const store = seededStore();
  const server = await startServer({ root, store, displayPort: 0, adminPort: 0 });
  const admin = await connect(server.adminPort);
  const tv = await connect(server.displayPort);
  t.after(async () => { admin.socket.disconnect(); tv.socket.disconnect(); await server.close(); });
  store.fail = true;
  const result = await send(admin, { type: "start" });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk failure/);
  assert.equal(tv.state.phase, "setup");
  assert.equal(store.state.revision, 0);
  store.fail = false;
  assert.equal((await send(admin, { type: "start" })).ok, true);
});
test("CSV replacement is atomic and a valid reload resets progress but preserves names and audio", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeopardy-csv-"));
  const raw = fs.readFileSync(path.join(root, "boards.template.csv"), "utf8");
  fs.writeFileSync(path.join(dir, "invalid.csv"), "round,category,value,clue,answer,daily_double\n");
  fs.writeFileSync(path.join(dir, "replacement.csv"), raw.replace("Our home planet is the third one from the Sun.", "A replacement clue."));
  const store = seededStore();
  const server = await startServer({ root: dir, store, displayPort: 0, adminPort: 0 });
  const admin = await connect(server.adminPort);
  t.after(async () => { admin.socket.disconnect(); await server.close(); fs.rmSync(dir, { recursive: true }); });
  await send(admin, { type: "rename", contestant: 0, name: "Keep this name" });
  await send(admin, { type: "audio", muted: true, volume: .25 });
  await send(admin, { type: "start" });
  await send(admin, { type: "adjust_score", contestant: 0, delta: 800 });
  const revision = admin.state.revision;
  const result = await send(admin, { type: "select_csv", filename: "invalid.csv", confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(store.state.revision, revision);
  assert.equal(store.state.game.contestants[0].score, 800);
  assert.equal(store.state.game.filename, "boards.template.csv");
  assert.equal((await send(admin, { type: "select_csv", filename: "replacement.csv", confirmed: true })).ok, true);
  assert.equal(admin.state.phase, "setup");
  assert.equal(admin.state.contestants[0].name, "Keep this name");
  assert.equal(admin.state.contestants[0].score, 0);
  assert.equal(admin.state.audio.muted, true);
  assert.equal(admin.state.audio.volume, .25);
  assert.equal(admin.state.canUndo, false);
  assert.equal(store.state.game.data.jeopardy.clues[0].clue, "A replacement clue.");
});
test("server expires Final timer, restores overdue timers on boot, and keeps hidden Final data private", async (t) => {
  const store = seededStore();
  let now = 1000;
  let server = await startServer({ root, store, now: () => now, displayPort: 0, adminPort: 0 });
  let admin = await connect(server.adminPort);
  let tv = await connect(server.displayPort);
  t.after(async () => { admin.socket.disconnect(); tv.socket.disconnect(); await server.close(); });
  await send(admin, { type: "start" });
  await send(admin, { type: "adjust_score", contestant: 0, delta: 1000 });
  await send(admin, { type: "advance", confirmed: true, contestant: 1 });
  await send(admin, { type: "advance", confirmed: true });
  await send(admin, { type: "final_wager", contestant: 0, amount: 900 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tv.state.final.entries[0].wager, undefined);
  assert.equal(tv.state.final.clue, undefined);
  await send(admin, { type: "lock_wagers" });
  await send(admin, { type: "start_timer" });
  admin.socket.disconnect(); tv.socket.disconnect(); await server.close();
  now = 32000;
  server = await startServer({ root, store, now: () => now, displayPort: 0, adminPort: 0 });
  admin = await connect(server.adminPort); tv = await connect(server.displayPort);
  assert.equal(admin.state.phase, "final_judging");
  assert.equal(admin.state.timer.expired, true);
  assert.equal(admin.state.private.finalEntries[0].wager, 900);
  await send(admin, { type: "final_judge", contestant: 0, correct: true });
  assert.equal(tv.state.final.entries[0].correct, undefined);
  await send(admin, { type: "final_reveal" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tv.state.final.entries[0].wager, 900);
  assert.equal(tv.state.contestants[0].score, 1900);
  await send(admin, { type: "undo" });
  assert.equal(admin.state.contestants[0].score, 1000);
  assert.equal(admin.state.timer.expired, true);
  await send(admin, { type: "undo" });
  await send(admin, { type: "undo" });
  assert.equal(admin.state.phase, "final_judging");
  assert.equal((await send(admin, { type: "start_timer" })).ok, false);
  await send(admin, { type: "undo" });
  assert.equal(admin.state.phase, "final_wagers");
  await send(admin, { type: "lock_wagers" });
  await send(admin, { type: "start_timer" });
  now = 63000;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server timer did not expire")), 2000);
    const listener = (s) => {
      if (s.phase === "final_judging") { clearTimeout(timeout); admin.socket.off("state", listener); resolve(); }
    };
    admin.socket.on("state", listener);
  });
  assert.equal(admin.state.timer.expired, true);
});
test("corrupt saved state fails explicitly rather than starting a new game", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeopardy-corrupt-"));
  const store = new Store(path.join(dir, "game.db"));
  try {
    store.save({ version: 2 });
    assert.throws(() => store.load(), /Unsupported/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true }); }
});

test("rules synchronize all TVs, reconnect and restart without publishing private Final data", async (t) => {
  const store = seededStore();
  let server = await startServer({ root, store, displayPort: 0, adminPort: 0 });
  let admin = await connect(server.adminPort);
  let tv = await connect(server.displayPort);
  let other = await connect(server.displayPort);
  t.after(async () => {
    admin.socket.disconnect(); tv.socket.disconnect(); other.socket.disconnect(); await server.close();
  });
  await send(admin, { type: "start" });
  await send(admin, { type: "adjust_score", contestant: 0, delta: 1000 });
  await send(admin, { type: "advance", confirmed: true, contestant: 1 });
  await send(admin, { type: "advance", confirmed: true });
  await send(admin, { type: "final_wager", contestant: 0, amount: 777 });
  for (const visible of [true, false, true]) {
    const before = structuredClone(store.state);
    const updates = [once(tv.socket, "state"), once(other.socket, "state")];
    assert.equal((await send(admin, { type: "rules", visible })).ok, true);
    await Promise.all(updates);
    assert.equal(admin.state.rulesVisible, visible);
    for (const client of [tv, other]) {
      assert.equal(client.state.rulesVisible, visible);
      assert.equal(client.state.private, undefined);
      assert.equal(client.state.final.entries[0].wager, undefined);
      assert.equal(client.state.final.clue, undefined);
      assert.equal(client.state.final.answer, undefined);
      assert.equal(JSON.stringify(client.state).includes('"dailyClues"'), false);
    }
    assert.deepEqual({ ...store.state.game, rulesVisible: before.game.rulesVisible }, before.game);
    assert.deepEqual(store.state.history, before.history);
  }
  const rules = await fetch(`http://127.0.0.1:${server.displayPort}/shared/rules.js`);
  assert.equal(rules.status, 200);
  assert.match(await rules.text(), /No penalty/);
  other.socket.disconnect();
  other = await connect(server.displayPort);
  assert.equal(other.state.rulesVisible, true);
  admin.socket.disconnect(); tv.socket.disconnect(); other.socket.disconnect(); await server.close();
  server = await startServer({ root, store, displayPort: 0, adminPort: 0 });
  admin = await connect(server.adminPort);
  tv = await connect(server.displayPort);
  other = await connect(server.displayPort);
  assert.equal(tv.state.rulesVisible, true);
  assert.equal(admin.state.private.finalEntries[0].wager, 777);
});
