import express from "express";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server as IOServer } from "socket.io";
import { isFileCommand, validateEnvelope } from "./commands";
import { listBoards, loadBoard } from "./csv";
import { StateStore, Store } from "./persist";
import { adminState, displayState } from "./projection";
import { applyCommand, initialState } from "./state";
import { expireTimer } from "./timer";
import { SavedState } from "./types";
import { clueImageUrl, readClueImage } from "./images";

interface Options {
  root?: string;
  dbPath?: string;
  displayPort?: number;
  adminPort?: number;
  store?: StateStore;
  now?: () => number;
}
export async function startServer(options: Options = {}) {
  const root = options.root ?? path.resolve(__dirname, "..");
  const now = options.now ?? Date.now;
  const store = options.store ?? new Store(options.dbPath ?? process.env.DB_PATH ?? path.join(root, "jeopardy.db"));
  let state: SavedState;
  try {
    const saved = store.load();
    if (saved) state = saved;
    else {
      const filename = existsSync(path.join(root, "boards.csv")) ? "boards.csv" : "boards.template.csv";
      state = initialState(loadBoard(root, filename), filename);
      store.save(state);
    }
    const expired = structuredClone(state);
    if (expireTimer(expired.game, now())) {
      expired.revision++;
      store.save(expired);
      state = expired;
    }
  } catch (error) { store.close(); throw error; }
  const displayApp = express();
  const adminApp = express();
  for (const [app, role] of [[displayApp, "display"], [adminApp, "admin"]] as const) {
    app.disable("x-powered-by");
    app.get("/health", (_req, res) => res.json({ ok: true, role }));
    app.get("/clue-image/:token", (req, res) => {
      res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      const visible = displayState(state, now());
      if (req.path !== visible.active?.imageUrl && req.path !== visible.final.imageUrl) {
        res.status(404).send("Clue image is not available.");
        return;
      }
      const clues = [...state.game.data[state.game.round].clues, state.game.data.final];
      const clue = clues.find((c) => c.image && clueImageUrl(state.game.filename, c) === req.path);
      if (!clue?.image) {
        res.status(404).send("Clue image is not available.");
        return;
      }
      try {
        const image = readClueImage(path.join(root, state.game.filename), clue.image);
        res.type(image.contentType).send(image.data);
      } catch (error) {
        console.error("[image]", error);
        res.status(404).send("Clue image could not be loaded. Check the file beside the CSV.");
      }
    });
    app.use("/shared", express.static(path.join(root, "public", "shared")));
    app.use(express.static(path.join(root, "public", role)));
  }
  const displayServer = http.createServer(displayApp);
  const adminServer = http.createServer(adminApp);
  const socketOptions = {
    maxHttpBufferSize: 16_384,
    // Host-only LAN service: reject cross-origin browser control, without restricting native test clients.
    allowRequest: (req: http.IncomingMessage, callback: (error: string | null, success: boolean) => void) => {
      const origin = req.headers.origin;
      let allowed = !origin;
      if (origin) {
        try { allowed = new URL(origin).host === req.headers.host; } catch { allowed = false; }
      }
      callback(allowed ? null : "Origin is not allowed.", allowed);
    },
  };
  const displayIo = new IOServer(displayServer, socketOptions);
  const adminIo = new IOServer(adminServer, socketOptions);
  const broadcast = () => {
    const timestamp = now();
    displayIo.emit("state", displayState(state, timestamp));
    adminIo.emit("state", adminState(state, timestamp));
  };
  displayIo.on("connection", (socket) => socket.emit("state", displayState(state, now())));
  adminIo.on("connection", (socket) => {
    socket.emit("state", adminState(state, now()));
    const files = () => {
      try { socket.emit("csv_files", listBoards(root)); }
      catch (error) {
        console.error("[csv]", error);
        socket.emit("error_msg", "Unable to list CSV files.");
      }
    };
    files();
    socket.on("list_csv_files", files);
    socket.on("cmd", (input: unknown, ack?: unknown) => {
      const reply = (value: object) => { if (typeof ack === "function") ack(value); };
      try {
        const envelope = validateEnvelope(input);
        if (state.receipts.includes(envelope.id)) {
          reply({ ok: true, duplicate: true, revision: state.revision });
          socket.emit("state", adminState(state, now()));
          return;
        }
        if (envelope.revision !== state.revision) throw new Error("State changed. Review the updated screen and try again.");
        let replacement;
        if (isFileCommand(envelope.command)) {
          if (!envelope.command.confirmed) throw new Error("Confirm replacing the current game.");
          replacement = { data: loadBoard(root, envelope.command.filename), filename: envelope.command.filename };
        }
        const candidate = applyCommand(state, envelope.command, envelope.id, now(), replacement);
        store.save(candidate);
        state = candidate;
        broadcast();
        reply({ ok: true, revision: state.revision });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Command failed.";
        console.error("[command]", message);
        reply({ ok: false, error: message, revision: state.revision });
        socket.emit("error_msg", message);
        socket.emit("state", adminState(state, now()));
      }
    });
  });
  let timerError: string | null = null;
  const interval = setInterval(() => {
    if (state.game.timer.endsAt === null || now() < state.game.timer.endsAt) return;
    const candidate = structuredClone(state);
    if (!expireTimer(candidate.game, now())) return;
    candidate.revision++;
    try {
      store.save(candidate);
      state = candidate;
      timerError = null;
      broadcast();
    } catch (error) {
      const message = `Timer could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      if (timerError !== message) {
        console.error(message);
        adminIo.emit("error_msg", message);
        timerError = message;
      }
    }
  }, 100);
  const listen = (server: http.Server, port: number) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to determine server port."));
      resolve(address.port);
    });
  });
  const close = async () => {
    clearInterval(interval);
    await Promise.all([displayIo, adminIo].map((io) => new Promise<void>((resolve) => io.close(() => resolve()))));
    store.close();
  };
  try {
    const displayPort = await listen(displayServer, options.displayPort ?? Number(process.env.DISPLAY_PORT ?? 3001));
    const adminPort = await listen(adminServer, options.adminPort ?? Number(process.env.ADMIN_PORT ?? 4001));
    return { displayPort, adminPort, close };
  } catch (error) { await close(); throw error; }
}
if (require.main === module) {
  startServer().then((server) => {
    console.log(`TV: http://localhost:${server.displayPort} | Admin: http://localhost:${server.adminPort}`);
    console.log("Use this computer's LAN IP from other devices. Admin has no login; use a trusted LAN only.");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => { server.close().then(() => process.exit(0)).catch((error) => {
        console.error("[shutdown]", error); process.exit(1);
      }); });
    }
  }).catch((error) => { console.error("[startup]", error); process.exitCode = 1; });
}
