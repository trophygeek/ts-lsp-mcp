import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** LSP-style zero-based position. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
  originSelectionRange?: LspRange;
}

export function pathToUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

export function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri; // non-file scheme; return verbatim
  }
}

/** Convert user-facing 1-based line/column to LSP 0-based. */
export function toLsp(line1: number, column1: number): LspPosition {
  return {
    line: Math.max(0, Math.floor(line1) - 1),
    character: Math.max(0, Math.floor(column1) - 1),
  };
}

/** Convert LSP 0-based position to user-facing 1-based. */
export function fromLsp(pos: LspPosition): { line: number; column: number } {
  return { line: pos.line + 1, column: pos.character + 1 };
}

export function relativize(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel.startsWith("..") ? absPath : rel;
}

/** Normalize Location | Location[] | LocationLink[] | null into Location[]. */
export function normalizeLocations(
  result: unknown,
): LspLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr
    .map((item): LspLocation | null => {
      const o = item as Record<string, unknown>;
      if (typeof o.uri === "string" && o.range) {
        return { uri: o.uri, range: o.range as LspRange };
      }
      if (typeof o.targetUri === "string") {
        const link = o as unknown as LspLocationLink;
        return {
          uri: link.targetUri,
          range: link.targetSelectionRange ?? link.targetRange,
        };
      }
      return null;
    })
    .filter((x): x is LspLocation => x !== null);
}
