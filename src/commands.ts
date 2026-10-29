import { Command, Envelope } from "./types";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
export function validateEnvelope(value: unknown): Envelope {
  requireCondition(record(value), "Invalid command envelope.");
  requireCondition(typeof value.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.id), "Invalid command ID.");
  requireCondition(integer(value.revision) && value.revision >= 0, "Invalid state revision.");
  const cmd = value.command;
  validateCommand(cmd);
  return { id: value.id, revision: value.revision, command: cmd };
}
function validateCommand(cmd: unknown): asserts cmd is Command {
  requireCondition(record(cmd) && typeof cmd.type === "string", "Invalid command.");
  const index = () => requireCondition(integer(cmd.contestant) && cmd.contestant >= 0 && cmd.contestant < 6, "Invalid contestant.");
  const boolean = (key: string) => requireCondition(typeof cmd[key] === "boolean", `${key} must be boolean.`);
  const amount = (key: string) => requireCondition(integer(cmd[key]), `${key} must be a whole safe number.`);
  const text = (key: string, max: number) => requireCondition(typeof cmd[key] === "string" &&
    cmd[key].trim().length > 0 && cmd[key].length <= max, `Invalid ${key}.`);
  switch (cmd.type) {
    case "configure":
      requireCondition(Array.isArray(cmd.names) && cmd.names.length >= 2 && cmd.names.length <= 6 &&
        cmd.names.every((name) => typeof name === "string" && name.trim().length > 0 && name.length <= 40),
      "Provide 2–6 names, each 1–40 characters.");
      break;
    case "rename": index(); text("name", 40); break;
    case "control": case "responder": index(); break;
    case "judge": boolean("correct"); break;
    case "rules": boolean("visible"); break;
    case "select": text("id", 100); break;
    case "daily_wager": case "final_wager": index(); amount("amount"); break;
    case "advance": boolean("confirmed"); if (cmd.contestant !== undefined) index(); break;
    case "final_judge": index(); boolean("correct"); break;
    case "adjust_score": index(); amount("delta"); break;
    case "start_timer":
      if (cmd.seconds !== undefined) requireCondition(integer(cmd.seconds) && cmd.seconds >= 1 && cmd.seconds <= 300,
        "Timer must be 1–300 seconds.");
      break;
    case "audio":
      boolean("muted");
      requireCondition(typeof cmd.volume === "number" && Number.isFinite(cmd.volume) && cmd.volume >= 0 && cmd.volume <= 1,
        "Volume must be between 0 and 1.");
      break;
    case "reset": boolean("confirmed"); break;
    case "select_csv": boolean("confirmed"); text("filename", 255); break;
    case "start": case "no_answer": case "reveal_answer": case "return_board": case "lock_wagers":
    case "final_reveal": case "finish": case "undo": break;
    default: throw new Error("Unknown command.");
  }
}

export function isFileCommand(cmd: Command): cmd is Extract<Command, { type: "select_csv" }> {
  return cmd.type === "select_csv";
}
