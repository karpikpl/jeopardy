import Database from "better-sqlite3";
import { integer, record, requireCondition as check } from "./commands";
import { parseBoard } from "./csv";
import { Game, SavedState } from "./types";

function assertGame(g: unknown): asserts g is Game {
  check(record(g) && record(g.data), "Saved game data is invalid.");
  const data = g.data;
  const clues: Record<string, unknown>[] = [];
  for (const round of ["jeopardy", "double_jeopardy"] as const) {
    const board = data[round];
    check(record(board) && Array.isArray(board.categories) && board.categories.every((c) => typeof c === "string") &&
      Array.isArray(board.clues), "Saved board is invalid.");
    for (const clue of board.clues) {
      check(record(clue), "Saved clue is invalid.");
      clues.push(clue);
    }
  }
  check(record(data.final), "Saved Final clue is invalid.");
  clues.push(data.final);
  const csvField = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  for (const clue of clues) {
    check(typeof clue.id === "string" && typeof clue.round === "string" && typeof clue.category === "string" &&
      typeof clue.clue === "string" && typeof clue.answer === "string" && integer(clue.value) &&
      typeof clue.dailyDouble === "boolean" && (clue.image === undefined || typeof clue.image === "string"),
    "Saved clue fields are invalid.");
  }
  const csv = "round,category,value,clue,answer,daily_double,image\n" + clues.map((c) =>
    [c.round, c.category, c.round === "final" ? "" : c.value, c.clue, c.answer, c.dailyDouble, c.image ?? ""]
      .map(csvField).join(",")).join("\n");
  check(JSON.stringify(parseBoard(csv)) === JSON.stringify(data), "Saved board does not match the supported schema.");
  const phases = ["setup", "board", "daily_wager", "clue", "resolved", "final_wagers", "final_clue",
    "final_thinking", "final_judging", "finished"];
  check(typeof g.phase === "string" && phases.includes(g.phase) &&
    (g.round === "jeopardy" || g.round === "double_jeopardy") && typeof g.filename === "string", "Saved phase is invalid.");
  check(Array.isArray(g.contestants) && g.contestants.length >= 2 && g.contestants.length <= 6 &&
    g.contestants.every((c) => record(c) && typeof c.name === "string" && c.name.length > 0 && c.name.length <= 40 && integer(c.score)),
  "Saved contestants are invalid.");
  const count = g.contestants.length;
  const index = (n: unknown) => integer(n) && n >= 0 && n < count;
  const ids = clues.map((c) => c.id);
  check(index(g.control) && Array.isArray(g.used) && g.used.every((id) => ids.includes(id)) &&
    new Set(g.used).size === g.used.length, "Saved board progress is invalid.");
  const activePhase = ["daily_wager", "clue", "resolved"].includes(g.phase);
  if (g.active !== null) {
    const a = g.active;
    check(record(a) && typeof a.id === "string" && ids.includes(a.id) && a.id.startsWith(`${g.round}:`) &&
      !g.used.includes(a.id) && (a.responder === null || index(a.responder)) &&
      Array.isArray(a.attempted) && a.attempted.every(index) && new Set(a.attempted).size === a.attempted.length &&
      (a.wager === null || (integer(a.wager) && a.wager >= 5)) && typeof a.answerVisible === "boolean",
    "Saved active clue is invalid.");
  }
  check(activePhase === (g.active !== null), "Saved active phase does not match its clue.");
  check(record(g.timer) && (g.timer.endsAt === null || (integer(g.timer.endsAt) && g.timer.endsAt >= 0)) &&
    typeof g.timer.expired === "boolean", "Saved timer is invalid.");
  check(record(g.audio) && typeof g.audio.muted === "boolean" && typeof g.audio.volume === "number" &&
    g.audio.volume >= 0 && g.audio.volume <= 1, "Saved audio is invalid.");
  check(g.rulesVisible === undefined || typeof g.rulesVisible === "boolean", "Saved rules visibility is invalid.");
  check(record(g.cue) && integer(g.cue.sequence) && g.cue.sequence >= 0 &&
    [null, "select", "correct", "incorrect", "reveal", "time", "daily"].includes(g.cue.kind as null | string),
  "Saved audio cue is invalid.");
  check(record(g.final) && typeof g.final.answerVisible === "boolean" && typeof g.final.skipped === "boolean" &&
    Array.isArray(g.final.entries), "Saved Final is invalid.");
  const seen = new Set<number>();
  for (const e of g.final.entries) {
    check(record(e) && index(e.contestant) && integer(e.score) && e.score > 0 &&
      (e.wager === null || (integer(e.wager) && e.wager >= 0 && e.wager <= e.score)) &&
      (e.correct === null || typeof e.correct === "boolean") && typeof e.revealed === "boolean" &&
      (!e.revealed || (e.wager !== null && e.correct !== null)), "Saved Final result is invalid.");
    check(!seen.has(e.contestant as number), "Saved Final contestant is duplicated.");
    seen.add(e.contestant as number);
  }
}
export function assertSavedState(saved: unknown): asserts saved is SavedState {
  check(record(saved) && saved.version === 1, "Unsupported or corrupt saved game; keep the database for recovery.");
  check(integer(saved.revision) && saved.revision >= 0 && Array.isArray(saved.history) &&
    Array.isArray(saved.receipts) && saved.receipts.every((id) => typeof id === "string") &&
    new Set(saved.receipts).size === saved.receipts.length, "Saved state metadata is invalid.");
  assertGame(saved.game);
  for (const entry of saved.history) assertGame(entry);
}
export interface StateStore { load(): SavedState | null; save(state: SavedState): void; close(): void }
export class Store implements StateStore {
  private db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL)");
  }
  load(): SavedState | null {
    const row = this.db.prepare("SELECT json FROM state WHERE id=1").get() as { json: string } | undefined;
    if (!row) return null;
    const value: unknown = JSON.parse(row.json);
    assertSavedState(value);
    return value;
  }
  save(state: SavedState): void {
    this.db.prepare("INSERT INTO state (id,json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
      .run(JSON.stringify(state));
  }
  close(): void { this.db.close(); }
}
