import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class JsonlParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly lineNumber: number,
    message: string,
  ) {
    super(`${path.basename(filePath)}:${lineNumber}: ${message}`);
    this.name = 'JsonlParseError';
  }
}

/**
 * Stream JSONL line-by-line. Blank lines are ignored. UTF-8 preserved.
 * Does not load the whole file into memory.
 */
export async function* streamJsonlLines(
  filePath: string,
  signal?: AbortSignal,
): AsyncGenerator<{ lineNumber: number; raw: string; value: unknown }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`JSONL file not found: ${filePath}`);
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) {
        throw new Error(`JSONL read aborted: ${filePath}`);
      }
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield { lineNumber, raw: line, value: JSON.parse(trimmed) as unknown };
      } catch (err) {
        throw new JsonlParseError(
          filePath,
          lineNumber,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function loadJsonlArray<T>(
  filePath: string,
  map: (value: unknown, lineNumber: number) => T,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  for await (const entry of streamJsonlLines(filePath, signal)) {
    items.push(map(entry.value, entry.lineNumber));
  }
  return items;
}

export function writeJsonlSync(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(filePath, body, 'utf-8');
}
