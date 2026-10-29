export type BoardRound = "jeopardy" | "double_jeopardy";
export type Phase = "setup" | "board" | "daily_wager" | "clue" | "resolved" |
  "final_wagers" | "final_clue" | "final_thinking" | "final_judging" | "finished";

export interface Clue {
  id: string;
  round: BoardRound | "final";
  category: string;
  value: number;
  clue: string;
  answer: string;
  dailyDouble: boolean;
  image?: string;
}
export interface Board {
  categories: string[];
  clues: Clue[];
}
export interface GameData {
  jeopardy: Board;
  double_jeopardy: Board;
  final: Clue;
}
export interface Contestant { name: string; score: number }
export interface ActiveClue {
  id: string;
  responder: number | null;
  attempted: number[];
  wager: number | null;
  answerVisible: boolean;
}
export interface Timer { endsAt: number | null; expired: boolean }
export interface FinalEntry {
  contestant: number;
  score: number;
  wager: number | null;
  correct: boolean | null;
  revealed: boolean;
}
export interface Game {
  data: GameData;
  filename: string;
  phase: Phase;
  round: BoardRound;
  contestants: Contestant[];
  control: number;
  used: string[];
  active: ActiveClue | null;
  timer: Timer;
  final: { entries: FinalEntry[]; answerVisible: boolean; skipped: boolean };
  audio: { muted: boolean; volume: number };
  rulesVisible?: boolean;
  cue: { sequence: number; kind: "select" | "correct" | "incorrect" | "reveal" | "time" | "daily" | null };
}
export interface SavedState {
  version: 1;
  revision: number;
  game: Game;
  history: Game[];
  receipts: string[];
}
export type Command =
  | { type: "configure"; names: string[] }
  | { type: "rename"; contestant: number; name: string }
  | { type: "start" }
  | { type: "control"; contestant: number }
  | { type: "select"; id: string }
  | { type: "responder"; contestant: number }
  | { type: "judge"; correct: boolean }
  | { type: "no_answer" }
  | { type: "reveal_answer" }
  | { type: "return_board" }
  | { type: "daily_wager"; contestant: number; amount: number }
  | { type: "advance"; confirmed: boolean; contestant?: number }
  | { type: "final_wager"; contestant: number; amount: number }
  | { type: "lock_wagers" }
  | { type: "start_timer"; seconds?: number }
  | { type: "final_judge"; contestant: number; correct: boolean }
  | { type: "final_reveal" }
  | { type: "finish" }
  | { type: "adjust_score"; contestant: number; delta: number }
  | { type: "audio"; muted: boolean; volume: number }
  | { type: "rules"; visible: boolean }
  | { type: "reset"; confirmed: boolean }
  | { type: "select_csv"; filename: string; confirmed: boolean }
  | { type: "undo" };

export interface Envelope { id: string; revision: number; command: Command }
export interface Cell { id: string; value: number; used: boolean }
export interface DisplayState {
  revision: number;
  serverTime: number;
  filename: string;
  phase: Phase;
  round: BoardRound;
  contestants: Contestant[];
  control: number;
  board: { category: string; cells: Cell[] }[];
  active: { category: string; value: number; clue?: string; imageUrl?: string; answer?: string; dailyDouble: boolean; responder: number | null; wager?: number } | null;
  final: {
    category: string | null;
    clue?: string;
    imageUrl?: string;
    answer?: string;
    entries: { contestant: number; revealed: boolean; wager?: number; correct?: boolean }[];
    skipped: boolean;
  };
  winners: number[];
  timer: Timer;
  audio: Game["audio"];
  rulesVisible: boolean;
  cue: Game["cue"];
}
export interface AdminState extends DisplayState {
  canUndo: boolean;
  private: {
    answer: string | null;
    attempted: number[];
    daily: boolean;
    finalEntries: FinalEntry[];
    dailyClues: string[];
  };
}
