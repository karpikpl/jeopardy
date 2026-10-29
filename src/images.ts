import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { requireCondition as check } from "./commands";
import { Clue } from "./types";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

export function validateImagePath(filename: string): void {
  check(filename.length > 0 && !filename.includes("\0") && !filename.includes("\\") &&
    !filename.includes(":") && !path.posix.isAbsolute(filename) &&
    !filename.split("/").includes(".."),
  "image must be a relative path within the CSV directory (for example images/photo.png).");
  check(Object.hasOwn(CONTENT_TYPES, path.extname(filename).toLowerCase()),
    "image must be a PNG, JPEG, GIF or WebP file.");
}

export function readClueImage(csvFilename: string, filename: string): { data: Buffer; contentType: string } {
  validateImagePath(filename);
  try {
    const directory = realpathSync(path.dirname(csvFilename));
    const resolved = realpathSync(path.resolve(directory, filename));
    const relative = path.relative(directory, resolved);
    check(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "Image resolves outside the CSV directory.");
    check(statSync(resolved).isFile(), "Image is not a regular file.");
    const data = readFileSync(resolved);
    const contentType = CONTENT_TYPES[path.extname(filename).toLowerCase()];
    const valid = contentType === "image/png" ? data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) :
      contentType === "image/jpeg" ? data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) :
      contentType === "image/gif" ? ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")) :
      data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
    check(valid, "File contents do not match the image format.");
    return { data, contentType };
  } catch (error) {
    throw new Error(`Cannot load image "${filename}" relative to "${path.dirname(csvFilename)}": ${
      error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function clueImageUrl(filename: string, clue: Clue): string | undefined {
  if (!clue.image) return undefined;
  const token = createHash("sha256").update(JSON.stringify([filename, clue.id, clue.image])).digest("hex");
  return `/clue-image/${token}`;
}
