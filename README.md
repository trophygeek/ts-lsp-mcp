# ts-lsp-mcp

An MCP (Model Context Protocol) server that gives coding LLMs real semantic understanding of TypeScript/JavaScript projects by bridging to the **TypeScript 7 native language server** (`tsc --lsp --stdio`, the Go-based compiler released July 2026).

Instead of grepping, an agent can ask: *where is this defined, who references it, what's its inferred type, does this file type-check?* — answered by the actual compiler in milliseconds.

## Architecture

```
LLM host (Claude Code / VSCode / Antigravity / ...)
        │  MCP over stdio
        ▼
   ts-lsp-mcp (this project, Node)
        │  LSP (JSON-RPC over stdio)
        ▼
   tsc --lsp --stdio   (TypeScript 7 native, Go binary)
```

- **Single project root** per server instance (pass `--root`). Run multiple instances for multiple projects.
- **Read-only**: navigation and diagnostics only; it never modifies your files.
- **Lazy + self-healing**: the LSP process starts on the first tool call and is transparently restarted if it crashes.
- **Disk-truth sync**: before every request, the file is re-read from disk and synced to the server, so results reflect the latest edits made by you or your agent.

## Tools exposed

| Tool | What it does |
| --- | --- |
| `ts_definition` | Go to definition — by `symbol` name or `file`/`line`/`column` |
| `ts_type_definition` | Jump to the *type's* declaration |
| `ts_implementations` | Find implementations of an interface/abstract member |
| `ts_references` | Find all true references project-wide (follows aliased imports; no comment/string false positives) |
| `ts_hover` | Inferred type + JSDoc for a symbol |
| `ts_document_symbols` | Outline of a file (classes, functions, …) |
| `ts_workspace_symbols` | Fuzzy symbol search across the project |
| `ts_diagnostics` | Type-check a file, errors with code context |
| `ts_server_info` | Which TS binary/version is in use |

All positions are **1-based** (line and column), matching what LLMs and editors display.

### Targeting symbols by name (agent-friendly)

Every navigation tool accepts **either** a bare `symbol` name **or** an exact position:

```jsonc
{ "symbol": "offerSpotToWaitlist" }            // one call, no position needed
{ "symbol": "process", "file": "src/queue.ts" } // disambiguate same-named symbols
{ "file": "src/queue.ts", "line": 42, "column": 10 } // exact occurrence
```

Names are resolved through the compiler's semantic index (`workspace/symbol`). Ambiguous names return a disambiguation list; unknown names return close matches. This makes the common agent workflow a single call — no grep-then-position two-step.

### Agent-friendly output (v0.3)

Positional queries echo the identifier actually under the position (`124 reference(s) to 'internal' (symbol at …)`) so an off-by-a-few column guess is visible instead of silently answering about the wrong symbol. Reference results lead with a per-file tally, and when every reference is in one file the output warns that codegen/proxy indirection (e.g. framework-generated API namespaces) may hide cross-file usages and suggests a text-search cross-check. `ts_document_symbols` defaults to declaration-level output (pass `depth: "all"` for locals). Results end with `//`-prefixed next-step hints (`// callers: ts_references({symbol: "…"})`), so the follow-up call is spelled out in the output itself.

## Requirements

- Node.js ≥ 18.17 (to run this MCP server)
- TypeScript 7 available for the *target* project — any of:
  - `npm install -D typescript@^7` in that project (recommended), or
  - `npm install -g @typescript/native-preview` (provides `tsgo`), or
  - an explicit binary via `--lsp-path` / `TS_LSP_SERVER_PATH`

Binary resolution order: explicit path → project-local `node_modules/.bin/tsc` (v7+) → project-local `tsgo` → `tsgo` on PATH → `tsc` on PATH (v7+). A TypeScript ≤ 6 `tsc` is rejected (it has no `--lsp` flag).

## Install & build

```bash
cd ts-lsp-mcp
npm install
npm run build

# sanity check against a real project:
node dist/index.js --root /path/to/your/ts/project --self-test
```

## Hooking it up

### Claude Code

```bash
claude mcp add ts-lsp -- node /abs/path/to/ts-lsp-mcp/dist/index.js --root /abs/path/to/your/project
```

Or in `.mcp.json` at your project root (then `--root` can be omitted since cwd is the project):

```json
{
  "mcpServers": {
    "ts-lsp": {
      "command": "node",
      "args": ["/abs/path/to/ts-lsp-mcp/dist/index.js"]
    }
  }
}
```

### VS Code (Copilot/agent MCP config, `.vscode/mcp.json`)

```json
{
  "servers": {
    "ts-lsp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/abs/path/to/ts-lsp-mcp/dist/index.js",
        "--root", "${workspaceFolder}"
      ]
    }
  }
}
```

### Antigravity / other MCP hosts

Any host that supports stdio MCP servers works the same way — configure the command as `node /abs/path/to/ts-lsp-mcp/dist/index.js --root <projectDir>`. Check your host's docs for where its `mcp.json` (or equivalent) lives.

## Configuration reference

| Flag | Env var | Meaning |
| --- | --- | --- |
| `--root <dir>` | `TS_LSP_PROJECT_ROOT` | Project root (default: cwd) |
| `--lsp-path <bin>` | `TS_LSP_SERVER_PATH` | Explicit TS 7 binary (`tsc` or `tsgo`) |
| `--self-test` | — | Resolve binary, do an LSP handshake, exit |

## Notes & limitations

- **Columns are UTF-16 based** (the LSP default). For ordinary code this matches character counts; lines containing emoji/astral characters may be off by code-unit differences.
- **Embedded languages** (Vue SFCs, Svelte, Astro, MDX, Angular templates) are not supported by TypeScript 7's language server yet — those ecosystems still depend on the TS 6 API. Plain `.ts/.tsx/.js/.jsx` is fully supported.
- TypeScript 7.0 ships **no programmatic API** (planned for 7.1); LSP is the supported integration surface, which is exactly what this project uses.
- Files outside `--root` are rejected by design.

## Development

```bash
npm run dev          # run from source via tsx
npm run build        # compile with the TS7 tsc (fast!)
```

Project layout:

```
src/
  index.ts          CLI entry, MCP stdio transport
  config.ts         TS7 binary resolution + version gating
  session.ts        LSP lifecycle (lazy start, restart-on-crash)
  resolve.ts        symbol-name -> position resolution + disambiguation
  lsp/
    jsonrpc.ts      Content-Length framing codec
    client.ts       LSP client (handshake, requests, diagnostics)
    documents.ts    didOpen/didChange sync from disk
  mcp/
    server.ts       MCP tool definitions
  util/
    position.ts     1-based ⇄ 0-based, path ⇄ URI
    snippet.ts      source previews / context snippets
```

## License

MIT
