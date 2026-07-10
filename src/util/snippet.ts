import * as fs from "node:fs";

const fileCache = new Map<string, { mtimeMs: number; lines: string[] }>();

function readLines(absPath: string): string[] | null {
  try {
    const stat = fs.statSync(absPath);
    const cached = fileCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lines;
    const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
    fileCache.set(absPath, { mtimeMs: stat.mtimeMs, lines });
    return lines;
  } catch {
    return null;
  }
}

/** Return the trimmed source line at a 1-based line number. */
export function lineAt(absPath: string, line1: number): string | null {
  const lines = readLines(absPath);
  if (!lines) return null;
  const line = lines[line1 - 1];
  return line === undefined ? null : line.trim().slice(0, 240);
}

/** Extract the identifier ([A-Za-z0-9_$]+) under a 1-based line/column, if any. */
export function identifierAt(
  absPath: string,
  line1: number,
  column1: number,
): string | null {
  const lines = readLines(absPath);
  if (!lines) return null;
  const line = lines[line1 - 1];
  if (line === undefined || line.length === 0) return null;
  const idx = Math.min(Math.max(column1 - 1, 0), line.length - 1);
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch);
  if (!isWord(line[idx])) return null;
  let s = idx;
  let e = idx;
  while (s > 0 && isWord(line[s - 1])) s--;
  while (e < line.length - 1 && isWord(line[e + 1])) e++;
  return line.slice(s, e + 1);
}

/**
 * Return numbered context lines around a 1-based line.
 * Example output (contextLines = 2):
 *   10 | function foo() {
 *   11 |   const x = 1;
 * > 12 |   return x;
 *   13 | }
 */
export function contextSnippet(
  absPath: string,
  line1: number,
  contextLines = 2,
): string | null {
  const lines = readLines(absPath);
  if (!lines) return null;
  const start = Math.max(1, line1 - contextLines);
  const end = Math.min(lines.length, line1 + contextLines);
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const marker = n === line1 ? ">" : " ";
    out.push(
      `${marker} ${String(n).padStart(width)} | ${(lines[n - 1] ?? "").slice(0, 240)}`,
    );
  }
  return out.join("\n");
}
