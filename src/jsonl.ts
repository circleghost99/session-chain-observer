import fs from "fs";
import readline from "readline";

export type JsonlRecord = {
  obj: any;
  line: string;
  lineNo: number;
};

export async function* readJsonl(filePath: string): AsyncGenerator<JsonlRecord> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      try {
        yield { obj: JSON.parse(line), line, lineNo };
      } catch {
        // A live transcript may expose a partially-written final line.
        continue;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export function statFile(filePath: string): { sizeBytes: number; mtimeMs: number } {
  const st = fs.statSync(filePath);
  return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
}
