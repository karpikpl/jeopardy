import { parse } from "csv-parse/sync";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BoardRound, Clue, GameData } from "./types";
import { readClueImage, validateImagePath } from "./images";

const HEADERS = ["round", "category", "value", "clue", "answer", "daily_double"];
export function parseBoard(raw: string): GameData {
  const rows: Record<string, string>[] = parse(raw, {
    bom: true,
    columns(headers: string[]) {
      const normalized = headers.map((h) => h.trim().toLowerCase());
      if (new Set(normalized).size !== normalized.length ||
          normalized.some((h) => !HEADERS.includes(h) && h !== "image") ||
          HEADERS.some((h) => !normalized.includes(h))) {
        throw new Error(`CSV headers must be: ${HEADERS.join(", ")}. An image column is optional.`);
      }
      return normalized;
    },
    skip_empty_lines: true,
    trim: true,
  });
  const data: GameData = {
    jeopardy: { categories: [], clues: [] },
    double_jeopardy: { categories: [], clues: [] },
    final: { id: "final", round: "final", category: "", value: 0, clue: "", answer: "", dailyDouble: false },
  };
  let finalCount = 0;
  rows.forEach((row, i) => {
    const fail = (message: string): never => { throw new Error(`CSV record ${i + 2}: ${message}`); };
    const { round, category, value, clue, answer, daily_double: daily } = row;
    const image = row.image;
    if (image) {
      try { validateImagePath(image); }
      catch (error) { fail(error instanceof Error ? error.message : "Invalid image path."); }
    }
    if (!["jeopardy", "double_jeopardy", "final"].includes(round)) fail("unknown round.");
    if (!category || !clue || !answer) fail("category, clue and answer must not be empty.");
    if (daily !== "true" && daily !== "false") fail("daily_double must be true or false.");
    if (round === "final") {
      if (value !== "" || daily !== "false") fail("Final needs a blank value and daily_double=false.");
      data.final = { id: "final", round, category, value: 0, clue, answer, dailyDouble: false, ...(image ? { image } : {}) };
      finalCount++;
      return;
    }
    const boardRound = round as BoardRound;
    const board = data[boardRound];
    const step = round === "jeopardy" ? 200 : 400;
    if (!/^\d+$/.test(value) || ![1, 2, 3, 4, 5].map((n) => step * n).includes(Number(value))) {
      fail(`value must be one of ${[1, 2, 3, 4, 5].map((n) => step * n).join(", ")}.`);
    }
    if (!board.categories.includes(category)) board.categories.push(category);
    const id = `${round}:${board.categories.indexOf(category)}:${Number(value)}`;
    if (board.clues.some((c) => c.id === id)) fail(`duplicate cell ${category}/${value}.`);
    const cell: Clue = { id, round: boardRound, category, value: Number(value), clue, answer,
      dailyDouble: daily === "true", ...(image ? { image } : {}) };
    board.clues.push(cell);
  });
  for (const round of ["jeopardy", "double_jeopardy"] as const) {
    const board = data[round];
    if (board.categories.length !== 6 || board.clues.length !== 30 ||
        board.categories.some((c) => board.clues.filter((clue) => clue.category === c).length !== 5)) {
      throw new Error(`${round}: expected six categories with five distinct value cells each.`);
    }
    const doubles = round === "jeopardy" ? 1 : 2;
    if (board.clues.filter((c) => c.dailyDouble).length !== doubles) {
      throw new Error(`${round}: expected exactly ${doubles} Daily Double(s).`);
    }
  }
  if (finalCount !== 1) throw new Error("CSV must contain exactly one Final clue.");
  return data;
}
export function listBoards(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => entry.name).sort();
}
export function loadBoard(root: string, filename: string): GameData {
  if (!listBoards(root).includes(filename)) throw new Error("Select a CSV from the server's list.");
  const csvFilename = path.join(root, filename);
  const data = parseBoard(readFileSync(csvFilename, "utf8"));
  const images = new Set([...data.jeopardy.clues, ...data.double_jeopardy.clues, data.final].flatMap((c) => c.image ? [c.image] : []));
  for (const image of images) readClueImage(csvFilename, image);
  return data;
}
