import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Session } from "../session.js";
import { LspError, METHOD_NOT_FOUND, type LspClient, type LspDiagnostic } from "../lsp/client.js";
import {
  resolveTarget,
  formatSymbolMatch,
  SYMBOL_KINDS,
  type SymbolInformation,
  type TargetArgs,
} from "../resolve.js";
import {
  fromLsp,
  normalizeLocations,
  relativize,
  uriToPath,
  type LspPosition,
  type LspRange,
} from "../util/position.js";
import { contextSnippet, lineAt } from "../util/snippet.js";

export { Session } from "../session.js";
export type { SessionOptions } from "../session.js";

const SEVERITY = ["", "error", "warning", "info", "hint"];

// ---------- formatting helpers ----------

function formatLocation(root: string, uri: string, range: LspRange): string {
  const abs = uriToPath(uri);
  const { line, column } = fromLsp(range.start);
  const preview = lineAt(abs, line);
  const loc = `${relativize(root, abs)}:${line}:${column}`;
  return preview !== null ? `${loc}\n    ${preview}` : loc;
}

function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Pull the symbol name out of a describe string like `'foo' (symbol at ...)`. */
function symbolNameOf(describe: string): string | null {
  const m = /^'([^']+)'/.exec(describe);
  return m ? m[1] : null;
}

/** Per-file reference tally, e.g. `a.ts ×12, b.ts ×3` (capped). */
function fileTally(root: string, locations: { uri: string }[]): {
  count: number;
  text: string;
} {
  const byFile = new Map<string, number>();
  for (const loc of locations) {
    const rel = relativize(root, uriToPath(loc.uri));
    byFile.set(rel, (byFile.get(rel) ?? 0) + 1);
  }
  const entries = [...byFile.entries()];
  const shown = entries
    .slice(0, 15)
    .map(([f, n]) => (n > 1 ? `${f} ×${n}` : f))
    .join(", ");
  const more = entries.length > 15 ? `, +${entries.length - 15} more files` : "";
  return { count: byFile.size, text: shown + more };
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: DocumentSymbol[];
}

/** Symbol kinds that are containers of declarations (children shown even in
 * "declarations" mode): module, namespace, class, enum, interface, object, struct. */
const CONTAINER_KINDS = new Set([2, 3, 5, 10, 11, 19, 23]);

function renderSymbolTree(
  symbols: DocumentSymbol[],
  mode: "declarations" | "all",
  depth = 0,
): string[] {
  const out: string[] = [];
  for (const sym of symbols) {
    const { line, column } = fromLsp(sym.selectionRange.start);
    const kind = SYMBOL_KINDS[sym.kind] ?? `kind-${sym.kind}`;
    const detail = sym.detail ? ` — ${sym.detail.slice(0, 120)}` : "";
    out.push(`${"  ".repeat(depth)}[${kind}] ${sym.name}${detail} (${line}:${column})`);
    if (!sym.children?.length) continue;
    // In declarations mode, only descend into declaration containers
    // (classes, interfaces, enums, namespaces...). Function/method/variable
    // bodies are skipped — locals and callbacks are noise for orientation.
    if (mode === "all" || CONTAINER_KINDS.has(sym.kind)) {
      out.push(...renderSymbolTree(sym.children, mode, depth + 1));
    }
  }
  return out;
}

function formatDiagnostics(
  root: string,
  absPath: string,
  diags: LspDiagnostic[],
): string {
  if (!diags.length) return `No diagnostics — ${relativize(root, absPath)} is clean.`;
  const rel = relativize(root, absPath);
  const lines = diags.map((d) => {
    const { line, column } = fromLsp(d.range.start);
    const sev = SEVERITY[d.severity ?? 1] || "error";
    const code = d.code !== undefined ? ` [${d.source ?? "ts"}(${d.code})]` : "";
    const snippet = contextSnippet(absPath, line, 1);
    return `${sev.toUpperCase()} ${rel}:${line}:${column}${code}\n  ${d.message}${snippet ? `\n${snippet}` : ""}`;
  });
  return `${diags.length} diagnostic(s) in ${rel}:\n\n${lines.join("\n\n")}`;
}

// ---------- target resolution (symbol name OR exact position) ----------

const targetArgs = {
  symbol: z
    .string()
    .optional()
    .describe(
      "Symbol name (e.g. 'offerSpotToWaitlist' or 'UserService'). The easiest way to target a symbol — no position needed; it is resolved via project-wide semantic search. If multiple symbols share the name, you'll get a disambiguation list.",
    ),
  file: z
    .string()
    .optional()
    .describe(
      "File path relative to the project root. Required when using line/column; optional with `symbol` to disambiguate same-named symbols.",
    ),
  line: z.number().int().min(1).optional().describe("1-based line number (use with file + column)"),
  column: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based column of the identifier (use with file + line)"),
};

// ---------- tool registration ----------

export function registerTools(server: McpServer, session: Session): void {
  type RunOk = {
    ok: true;
    client: LspClient;
    uri: string;
    position: LspPosition;
    describe: string;
  };
  type RunResult = RunOk | { ok: false; failure: ReturnType<typeof asText> };

  const runPositional = async (args: TargetArgs): Promise<RunResult> => {
    const target = await resolveTarget(session, args);
    if (!target.ok) return { ok: false, failure: asText(target.message) };
    const { client, docs } = await session.ensure();
    const { uri } = await docs.ensureOpen(target.abs);
    return { ok: true, client, uri, position: target.position, describe: target.describe };
  };

  const locationTool = (name: string, description: string, method: string) => {
    server.registerTool(
      name,
      { description, inputSchema: targetArgs },
      async (args: TargetArgs) => {
        try {
          const r = await runPositional(args);
          if (!r.ok) return r.failure;
          const result = await r.client.request(method, {
            textDocument: { uri: r.uri },
            position: r.position,
          });
          const locations = normalizeLocations(result);
          if (!locations.length) {
            return asText(`No results for ${name} at ${r.describe}.`);
          }
          const body = locations
            .slice(0, 100)
            .map((loc) => formatLocation(session.root, loc.uri, loc.range))
            .join("\n");
          const truncated =
            locations.length > 100 ? `\n… ${locations.length - 100} more omitted` : "";
          const sym = symbolNameOf(r.describe);
          const hint =
            sym && name !== "ts_implementations"
              ? `\n\n// callers: ts_references({symbol: "${sym}"}) · type: ts_hover({symbol: "${sym}"})`
              : "";
          return asText(
            `${locations.length} result(s) for ${r.describe}:\n${body}${truncated}${hint}`,
          );
        } catch (err) {
          return errorText(err);
        }
      },
    );
  };

  locationTool(
    "ts_definition",
    "Jump to the definition of a symbol. Give just `symbol` (a name) — or file/line/column for a specific occurrence. Semantic: resolves through aliased imports, re-exports, and barrel files, which text search cannot.",
    "textDocument/definition",
  );
  locationTool(
    "ts_type_definition",
    "Jump to the declaration of a symbol's TYPE (e.g. from a variable to its interface). Give just `symbol`, or file/line/column.",
    "textDocument/typeDefinition",
  );
  locationTool(
    "ts_implementations",
    "Find concrete implementations of an interface, abstract class, or abstract member. Give just `symbol`, or file/line/column. Text search cannot answer this at all.",
    "textDocument/implementation",
  );

  server.registerTool(
    "ts_references",
    {
      description:
        "Find all TRUE code references to a symbol, project-wide, via the TypeScript compiler. Give just `symbol` (a name, e.g. 'offerSpotToWaitlist') — no position needed. Prefer this over grep for code: it tracks the symbol rather than the string, so it follows aliased imports (`import { x as y }`), re-exports, and destructuring, and has zero false positives from comments, strings, or unrelated same-named symbols. (Grep is still right for non-code files like markdown docs.)",
      inputSchema: {
        ...targetArgs,
        include_declaration: z
          .boolean()
          .optional()
          .describe("Include the declaration itself (default true)"),
      },
    },
    async ({ include_declaration, ...args }: TargetArgs & { include_declaration?: boolean }) => {
      try {
        const r = await runPositional(args);
        if (!r.ok) return r.failure;
        const result = await r.client.request("textDocument/references", {
          textDocument: { uri: r.uri },
          position: r.position,
          context: { includeDeclaration: include_declaration ?? true },
        });
        const locations = normalizeLocations(result);
        if (!locations.length) {
          return asText(`No references found for ${r.describe}.`);
        }
        const tally = fileTally(session.root, locations);
        const DETAIL_CAP = 40;
        const body = locations
          .slice(0, DETAIL_CAP)
          .map((loc) => formatLocation(session.root, loc.uri, loc.range))
          .join("\n");
        const truncated =
          locations.length > DETAIL_CAP
            ? `\n… ${locations.length - DETAIL_CAP} more omitted (see per-file tally above)`
            : "";
        // Honest-recall guard: compiler reference tracking can miss usages
        // routed through code-generated proxy/API layers (mapped types over
        // module imports), where the declaration->usage link is only
        // established within the declaring file.
        const caution =
          tally.count === 1
            ? `\n\n// note: all references are within one file. If this codebase routes calls through a generated API/proxy layer (framework codegen), cross-file usages may not be linked here — cross-check with a text search, which also covers docs/config files.`
            : "";
        return asText(
          `${locations.length} reference(s) to ${r.describe} in ${tally.count} file(s):\n// per-file: ${tally.text}\n${body}${truncated}${caution}`,
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "ts_hover",
    {
      description:
        "Get the inferred type signature and JSDoc for a symbol (the editor 'hover'). Give just `symbol`, or file/line/column. The fastest way to learn a symbol's actual type without reading its implementation.",
      inputSchema: targetArgs,
    },
    async (args: TargetArgs) => {
      try {
        const r = await runPositional(args);
        if (!r.ok) return r.failure;
        const result = (await r.client.request("textDocument/hover", {
          textDocument: { uri: r.uri },
          position: r.position,
        })) as { contents?: unknown } | null;
        const text = renderHoverContents(result?.contents);
        if (!text) return asText(`No hover information at ${r.describe}.`);
        const sym = symbolNameOf(r.describe);
        const hint = sym
          ? `\n\n// definition: ts_definition({symbol: "${sym}"}) · callers: ts_references({symbol: "${sym}"})`
          : "";
        return asText(text + hint);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "ts_document_symbols",
    {
      description:
        "Compact outline of a file: classes, functions, methods, interfaces with 1-based positions. Use this to orient in an unfamiliar file without reading it fully. Default shows declarations only; depth:\"all\" adds locals inside function bodies.",
      inputSchema: {
        file: z.string().describe("File path, relative to the project root"),
        depth: z
          .enum(["declarations", "all"])
          .optional()
          .describe(
            "declarations (default): top-level and class/interface members only. all: include locals and callbacks inside function bodies.",
          ),
      },
    },
    async ({ file, depth }: { file: string; depth?: "declarations" | "all" }) => {
      try {
        const abs = session.resolveFile(file);
        const { client, docs } = await session.ensure();
        const { uri } = await docs.ensureOpen(abs);
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri },
        });
        if (!Array.isArray(result) || result.length === 0) {
          return asText(`No symbols found in ${file}.`);
        }
        let lines: string[];
        if ("selectionRange" in (result[0] as object)) {
          lines = renderSymbolTree(result as DocumentSymbol[], depth ?? "declarations");
        } else {
          lines = (result as SymbolInformation[]).map((s) =>
            formatSymbolMatch(session.root, s),
          );
        }
        const LINE_CAP = 150;
        const shown = lines.slice(0, LINE_CAP).join("\n");
        const truncated =
          lines.length > LINE_CAP
            ? `\n… ${lines.length - LINE_CAP} more symbols omitted`
            : "";
        const hint = `\n\n// details: read ${file} at the line numbers above · types: ts_hover({symbol: "<name>", file: "${file}"})`;
        return asText(`Symbols in ${file}:\n${shown}${truncated}${hint}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "ts_workspace_symbols",
    {
      description:
        "Search symbols by name across the whole project (fuzzy, semantic index). Use to locate a class/function/type when you don't know which file it lives in.",
      inputSchema: {
        query: z.string().min(1).describe("Symbol name or fragment to search for"),
      },
    },
    async ({ query }: { query: string }) => {
      try {
        const { client } = await session.ensure();
        const result = await client.request("workspace/symbol", { query });
        const symbols = (Array.isArray(result) ? result : []) as SymbolInformation[];
        if (!symbols.length) return asText(`No workspace symbols match '${query}'.`);
        const lines = symbols
          .slice(0, 100)
          .map((s) => formatSymbolMatch(session.root, s));
        const truncated =
          symbols.length > 100 ? `\n… ${symbols.length - 100} more omitted` : "";
        const first = symbols[0]?.name ?? query;
        const hint = `\n\n// next: ts_hover({symbol: "${first}"}) for its type · ts_references({symbol: "${first}"}) for callers`;
        return asText(`${symbols.length} match(es):\n${lines.join("\n")}${truncated}${hint}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "ts_diagnostics",
    {
      description:
        "Type-check a file and return compiler errors/warnings with code context. Run after editing to verify changes.",
      inputSchema: {
        file: z.string().describe("File path, relative to the project root"),
      },
    },
    async ({ file }: { file: string }) => {
      try {
        const abs = session.resolveFile(file);
        const { client, docs } = await session.ensure();
        const { uri } = await docs.ensureOpen(abs);

        let diags: LspDiagnostic[] | undefined;
        try {
          const report = (await client.request("textDocument/diagnostic", {
            textDocument: { uri },
          })) as { kind?: string; items?: LspDiagnostic[] } | null;
          if (report && Array.isArray(report.items)) diags = report.items;
        } catch (err) {
          if (!(err instanceof LspError && err.code === METHOD_NOT_FOUND)) throw err;
        }
        if (diags === undefined) {
          diags = (await client.waitForPublishedDiagnostics(uri, 8_000)) ?? [];
        }
        return asText(formatDiagnostics(session.root, abs, diags));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "ts_server_info",
    {
      description:
        "Report which TypeScript language server binary is in use, its version, and the project root. Useful for debugging setup.",
      inputSchema: {},
    },
    async () => {
      try {
        await session.ensure();
        const cmd = session.serverCommand;
        const pathNote = cmd?.source.includes("PATH")
          ? `\n\n// note: resolved from PATH, not the project's own install. For results that match the project's exact TypeScript version, run: npm i -D typescript@^7 in ${session.root}`
          : "";
        return asText(
          [
            `Project root: ${session.root}`,
            `LSP command: ${cmd?.command} ${cmd?.args.join(" ")}`,
            `Resolved via: ${cmd?.source}`,
            `TypeScript version: ${cmd?.version ?? "unknown"}`,
          ].join("\n") + pathNote,
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );
}

function renderHoverContents(contents: unknown): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map(renderHoverContents).filter(Boolean).join("\n\n");
  }
  const o = contents as Record<string, unknown>;
  if (typeof o.value === "string") return o.value;
  return "";
}
