const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { io } = require("socket.io-client");
const { parseBoard, loadBoard } = require("../dist/csv");
const { readClueImage, clueImageUrl } = require("../dist/images");
const { Store } = require("../dist/persist");
const { initialState, applyCommand } = require("../dist/state");
const { displayState } = require("../dist/projection");
const { startServer } = require("../dist/server");

const raw = fs.readFileSync(path.join(__dirname, "../boards.template.csv"), "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK5cAAAAASUVORK5CYII=", "base64");
function csvWithImages(image = "images/planet.png") {
  return raw.trimEnd().split("\n").map((line, i) =>
    line + "," + (i === 0 ? "image" : [1, 3, 61].includes(i) ? `"${image.replaceAll('"', '""')}"` : "")).join("\n");
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeopardy-images-"));
  fs.mkdirSync(path.join(dir, "images"));
  fs.writeFileSync(path.join(dir, "images", "planet.png"), png);
  fs.writeFileSync(path.join(dir, "boards.template.csv"), csvWithImages());
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}
test("image column is optional and supports regular, Daily Double and Final clues", () => {
  const plain = parseBoard(raw);
  assert.equal(plain.jeopardy.clues[0].image, undefined);
  const data = parseBoard(csvWithImages());
  assert.equal(data.jeopardy.clues[0].image, "images/planet.png");
  assert.equal(data.jeopardy.clues[2].image, "images/planet.png");
  assert.equal(data.final.image, "images/planet.png");
  assert.equal(data.jeopardy.clues[1].image, undefined);
  assert.equal(parseBoard(csvWithImages("images/a,b.png")).final.image, "images/a,b.png");
  assert.throws(() => parseBoard(csvWithImages().replace(",image\n", ",image,image\n")), /headers/);
});
test("image paths reject traversal, absolute paths, remote sources and unsupported formats", () => {
  for (const filename of ["../secret.png", "images/../../secret.png", "/tmp/secret.png",
    "C:\\secret.png", "images\\photo.png", "https://example.com/a.png", "//example.com/a.png",
    "data:image/png;base64,abc", "images/a.svg", "images/a.html", "images/a\0.png"]) {
    assert.throws(() => parseBoard(csvWithImages(filename)), /CSV record 2: image/);
  }
  assert.equal(parseBoard(csvWithImages("./images/planet.PNG")).final.image, "./images/planet.PNG");
});
test("files resolve relative to the CSV and missing or non-image assets reject a board load", (t) => {
  const dir = fixture(t);
  assert.equal(loadBoard(dir, "boards.template.csv").final.image, "images/planet.png");
  assert.deepEqual(readClueImage(path.join(dir, "boards.template.csv"), "images/planet.png"), { data: png, contentType: "image/png" });
  fs.writeFileSync(path.join(dir, "images", "planet.png"), "<html>This is not an image</html>");
  assert.throws(() => loadBoard(dir, "boards.template.csv"), /Cannot load image.*contents do not match/);
  fs.unlinkSync(path.join(dir, "images", "planet.png"));
  assert.throws(() => loadBoard(dir, "boards.template.csv"), /Cannot load image.*planet.png/);
});
test("image resolution refuses symlinks that escape the CSV directory", (t) => {
  const dir = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jeopardy-outside-image-"));
  t.after(() => fs.rmSync(outside, { recursive: true }));
  fs.writeFileSync(path.join(outside, "planet.png"), png);
  fs.unlinkSync(path.join(dir, "images", "planet.png"));
  fs.symlinkSync(path.join(outside, "planet.png"), path.join(dir, "images", "planet.png"));
  assert.throws(() => loadBoard(dir, "boards.template.csv"), /outside the CSV directory/);
  fs.unlinkSync(path.join(dir, "images", "planet.png"));
  fs.rmdirSync(path.join(dir, "images"));
  fs.symlinkSync(outside, path.join(dir, "images"), "dir");
  assert.throws(() => loadBoard(dir, "boards.template.csv"), /outside the CSV directory/);
});
test("supported image formats are checked against file signatures", (t) => {
  const dir = fixture(t);
  for (const [name, bytes, contentType] of [
    ["a.JPG", Buffer.from("ffd8ffe00000", "hex"), "image/jpeg"],
    ["a.gif", Buffer.from("GIF89a"), "image/gif"],
    ["a.webp", Buffer.from("524946460000000057454250", "hex"), "image/webp"],
  ]) {
    fs.writeFileSync(path.join(dir, "images", name), bytes);
    assert.equal(readClueImage(path.join(dir, "boards.template.csv"), `images/${name}`).contentType, contentType);
  }
});
test("image metadata survives persistence and undo while legacy state remains valid", (t) => {
  const dir = fixture(t);
  const store = new Store(path.join(dir, "game.db"));
  t.after(() => store.close());
  const original = initialState(parseBoard(raw), "boards.template.csv");
  store.save(original);
  assert.deepEqual(store.load(), original);
  let saved = initialState(loadBoard(dir, "boards.template.csv"), "boards.template.csv");
  saved = applyCommand(saved, { type: "start" }, "start", 0);
  saved = applyCommand(saved, { type: "select", id: saved.game.data.jeopardy.clues[0].id }, "select", 0);
  store.save(saved);
  assert.deepEqual(store.load(), saved);
  saved = applyCommand(store.load(), { type: "no_answer" }, "close", 0);
  saved = applyCommand(saved, { type: "undo" }, "undo", 0);
  assert.ok(displayState(saved).active.imageUrl);
  const bad = structuredClone(saved);
  bad.game.data.jeopardy.clues[0].image = "../escape.png";
  store.save(bad);
  assert.throws(() => store.load(), /relative path/);
});

async function connect(port) {
  const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false, transports: ["websocket"], reconnection: false });
  let state;
  socket.on("state", (snapshot) => { state = snapshot; });
  const ready = once(socket, "state");
  socket.connect();
  await ready;
  return { socket, get state() { return state; } };
}
let sequence = 0;
async function send(client, command) {
  const result = await client.socket.timeout(3000).emitWithAck("cmd", {
    id: `image-test-${++sequence}`, revision: client.state.revision, command,
  });
  assert.equal(result.ok, true, result.error);
}
test("both servers serve only the revealed clue's image and recover it after restart", async (t) => {
  const dir = fixture(t);
  const dbPath = path.join(dir, "game.db");
  let server = await startServer({ root: dir, dbPath, displayPort: 0, adminPort: 0 });
  let admin = await connect(server.adminPort);
  t.after(async () => { admin.socket.disconnect(); await server.close(); });
  const data = loadBoard(dir, "boards.template.csv");
  const regular = data.jeopardy.clues[0];
  const daily = data.jeopardy.clues[2];
  const url = (clue) => clueImageUrl("boards.template.csv", clue);
  const get = (port, clue) => fetch(`http://127.0.0.1:${port}${url(clue)}`);
  assert.equal((await get(server.displayPort, regular)).status, 404);
  assert.equal((await get(server.displayPort, data.final)).status, 404);
  await send(admin, { type: "start" });
  await send(admin, { type: "select", id: regular.id });
  assert.equal(admin.state.active.imageUrl, url(regular));
  assert.ok(!JSON.stringify(admin.state.active).includes("images/planet.png"));
  for (const port of [server.adminPort, server.displayPort]) {
    const response = await get(port, regular);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
  assert.equal((await fetch(`http://127.0.0.1:${server.displayPort}/images/planet.png`)).status, 404);
  assert.equal((await get(server.displayPort, daily)).status, 404);
  admin.socket.disconnect();
  await server.close();
  server = await startServer({ root: dir, dbPath, displayPort: 0, adminPort: 0 });
  admin = await connect(server.adminPort);
  assert.equal(admin.state.active.imageUrl, url(regular));
  assert.equal((await get(server.displayPort, regular)).status, 200);
  await send(admin, { type: "no_answer" });
  await send(admin, { type: "return_board" });
  assert.equal((await get(server.displayPort, regular)).status, 404);
  await send(admin, { type: "select", id: daily.id });
  assert.equal(admin.state.active.imageUrl, undefined);
  assert.equal((await get(server.displayPort, daily)).status, 404);
  await send(admin, { type: "daily_wager", contestant: 0, amount: 5 });
  assert.equal((await get(server.displayPort, daily)).status, 200);
  await send(admin, { type: "judge", correct: true });
  await send(admin, { type: "return_board" });
  await send(admin, { type: "advance", confirmed: true, contestant: 1 });
  await send(admin, { type: "advance", confirmed: true });
  assert.equal(admin.state.final.imageUrl, undefined);
  assert.equal((await get(server.displayPort, data.final)).status, 404);
  await send(admin, { type: "final_wager", contestant: 0, amount: 0 });
  await send(admin, { type: "lock_wagers" });
  assert.equal(admin.state.final.imageUrl, url(data.final));
  assert.equal((await get(server.displayPort, data.final)).status, 200);
  fs.unlinkSync(path.join(dir, "images", "planet.png"));
  assert.equal((await get(server.displayPort, data.final)).status, 404);
});
test("an invalid image reload leaves the live game and its scores intact", async (t) => {
  const dir = fixture(t);
  const server = await startServer({ root: dir, dbPath: path.join(dir, "game.db"), displayPort: 0, adminPort: 0 });
  const admin = await connect(server.adminPort);
  t.after(async () => { admin.socket.disconnect(); await server.close(); });
  await send(admin, { type: "start" });
  await send(admin, { type: "adjust_score", contestant: 0, delta: 300 });
  const revision = admin.state.revision;
  fs.writeFileSync(path.join(dir, "bad.csv"), csvWithImages("images/missing.png"));
  const result = await admin.socket.timeout(3000).emitWithAck("cmd", {
    id: "bad-image-load", revision, command: { type: "select_csv", filename: "bad.csv", confirmed: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Cannot load image.*missing.png/);
  assert.equal(admin.state.revision, revision);
  assert.equal(admin.state.contestants[0].score, 300);
});
