import fs from "fs";
import readline from "readline";
import crypto from "crypto";

import type { ContentReadOptions, ContentReadResult, ContentRef } from "./model.js";

type RefPayload = {
  sourcePath: string;
  lineNo: number;
  jsonPointer: string;
};

const DEFAULT_PREVIEW_CHARS = 180;
const APPROX_CHARS_PER_TOKEN = 4;

export function makeContentRef(
  sourcePath: string,
  lineNo: number,
  jsonPointer: string,
  value: unknown,
  previewChars = DEFAULT_PREVIEW_CHARS,
): ContentRef {
  const text = valueToText(value);
  const payload: RefPayload = { sourcePath, lineNo, jsonPointer };
  const refId = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  return {
    refId,
    sourcePath,
    lineNo,
    jsonPointer,
    charCount: text.length,
    tokenEstimate: Math.ceil(text.length / APPROX_CHARS_PER_TOKEN),
    sha256,
    preview: text.length > previewChars ? text.slice(0, previewChars - 3) + "..." : text,
    truncated: text.length > previewChars,
  };
}

export async function readContentRef(refId: string, opts: ContentReadOptions = {}): Promise<ContentReadResult> {
  const payload = decodeRef(refId);
  const line = await readLine(payload.sourcePath, payload.lineNo);
  if (line === null) {
    throw new Error(`Content ref line not found: ${payload.sourcePath}:${payload.lineNo}`);
  }

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch (err: any) {
    throw new Error(`Content ref line is not valid JSON: ${err.message}`);
  }

  const value = readJsonPointer(obj, payload.jsonPointer);
  const text = valueToText(value);
  const start = Math.max(0, opts.start ?? 0);
  const chars = Math.max(1, opts.chars ?? 8000);
  const end = Math.min(text.length, start + chars);
  return {
    refId,
    text: text.slice(start, end),
    start,
    end,
    charCount: text.length,
    hasMore: end < text.length,
  };
}

export function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => valueToText(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const maybeText = (value as any).text;
    if (typeof maybeText === "string") return maybeText;
    const maybeContent = (value as any).content;
    if (typeof maybeContent === "string") return maybeContent;
  }
  return JSON.stringify(value, null, 2);
}

export function readJsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return value;
  const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = value;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function decodeRef(refId: string): RefPayload {
  try {
    const parsed = JSON.parse(Buffer.from(refId, "base64url").toString("utf8"));
    if (!parsed.sourcePath || !parsed.lineNo || !parsed.jsonPointer) {
      throw new Error("missing fields");
    }
    return parsed;
  } catch (err: any) {
    throw new Error(`Invalid content ref: ${err.message}`);
  }
}

async function readLine(filePath: string, targetLine: number): Promise<string | null> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo === targetLine) {
        rl.close();
        stream.destroy();
        return line;
      }
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}
