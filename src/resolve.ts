import type { Session } from "./session.js";
import { identifierAt } from "./util/snippet.js";
import {
  fromLsp,
  relativize,
  toLsp,
  uriToPath,
  type LspPosition,
  type LspRange,
} from "./util/position.js";

export const SYMBOL_KINDS = [
  "", "file", "module", "namespace", "package", "class", "method", "property",
  "field", "constructor", "enum", "interface", "function", "variable",
  "constant", "string", "number", "boolean", "array", "object", "key", "null",
  "enum-member", "struct", "event", "operator", "type-parameter",
];

export interface SymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
  containerName?: string;
}

export interface TargetArgs {
  symbol?: string;
  file?: string;
  line?: number;
  column?: number;
}

export type Resolved =
  | { ok: true; abs: string; position: LspPosition; describe: string }
  | { ok: false; message: string };

export function formatSymbolMatch(root: string, s: SymbolInformation): string {
  const abs = uriToPath(s.location.uri);
  const { line, column } = fromLsp(s.location.range.start);
  const kind = SYMBOL_KINDS[s.kind] ?? `kind-${s.kind}`;
  const container = s.containerName ? ` (in ${s.containerName})` : "";
  return `[${kind}] ${s.name}${container} — ${relativize(root, abs)}:${line}:${column}`;
}

function dedupeSymbols(matches: SymbolInformation[]): SymbolInformation[] {
  const seen = new Set<string>();
  return matches.filter((s) => {
    const key = `${s.location.uri}:${s.location.range.start.line}:${s.location.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve a tool target given either (a) a symbol name, resolved through the
 * server's semantic index via workspace/symbol, or (b) an exact 1-based
 * file/line/column position. Symbol mode returns a disambiguation message
 * when the name is ambiguous, and near-miss suggestions when it's unknown.
 */
export async function resolveTarget(
  session: Session,
  args: TargetArgs,
): Promise<Resolved> {
  const { symbol, file, line, column } = args;

  // Mode 1: exact position
  if (file && line !== undefined && column !== undefined) {
    const abs = session.resolveFile(file);
    // Echo which identifier sits under the position, so an off-by-a-few
    // column guess (e.g. landing on `internal` instead of the member after
    // it) is visible in the output instead of silently answering about the
    // wrong symbol.
    const ident = identifierAt(abs, line, column);
    return {
      ok: true,
      abs,
      position: toLsp(line, column),
      describe: ident
        ? `'${ident}' (symbol at ${file}:${line}:${column})`
        : `${file}:${line}:${column}`,
    };
  }

  // Mode 2: symbol name
  if (symbol) {
    const { client } = await session.ensure();
    const result = await client.request("workspace/symbol", { query: symbol });
    const all = (Array.isArray(result) ? result : []) as SymbolInformation[];

    let matches = dedupeSymbols(all.filter((s) => s.name === symbol));
    if (!matches.length) {
      matches = dedupeSymbols(
        all.filter((s) => s.name.toLowerCase() === symbol.toLowerCase()),
      );
    }
    if (file && matches.length > 1) {
      const absHint = session.resolveFile(file);
      const filtered = matches.filter((s) => uriToPath(s.location.uri) === absHint);
      if (filtered.length) matches = filtered;
    }

    if (matches.length === 1) {
      const m = matches[0];
      return {
        ok: true,
        abs: uriToPath(m.location.uri),
        position: m.location.range.start,
        describe: `'${symbol}'`,
      };
    }
    if (matches.length > 1) {
      const list = matches.slice(0, 15).map((s) => formatSymbolMatch(session.root, s));
      return {
        ok: false,
        message:
          `Multiple symbols named '${symbol}' — specify which one by re-calling with ` +
          `the matching \`file\` (plus \`symbol\`), or with exact file/line/column:\n` +
          list.join("\n"),
      };
    }
    const fuzzy = dedupeSymbols(all).slice(0, 10);
    return {
      ok: false,
      message: fuzzy.length
        ? `No symbol named exactly '${symbol}'. Close matches:\n` +
          fuzzy.map((s) => formatSymbolMatch(session.root, s)).join("\n")
        : `No symbol matching '${symbol}' found in the project (checked semantic index, not raw text).`,
    };
  }

  return {
    ok: false,
    message:
      "Provide either `symbol` (a name — simplest), or `file` + `line` + `column` (1-based).",
  };
}
