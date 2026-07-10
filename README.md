# ts-lsp-mcp

An MCP server that exposes the TypeScript 7 native language server (`tsc --lsp --stdio`, the Go-based compiler) to coding agents: go to definition, find references, hover types, file diagnostics — answered by the compiler that will actually build the project, rather than reconstructed from text search.

```
LLM host (Claude Code / VS Code / other MCP hosts)
        │  MCP over stdio
        ▼
   ts-lsp-mcp (this project, Node)
        │  LSP (JSON-RPC over stdio)
        ▼
   tsc --lsp --stdio   (TypeScript 7 native, Go binary)
```

The design constraints, stated up front:

- **One language, one project root per instance.** Pass `--root`; run multiple instances for multiple projects. This is not a polyglot bridge.
- **Read-only.** Navigation and diagnostics only. There are no rename, code-action, or edit tools, and there will not be; edits stay in the agent's normal file-editing path where they are reviewable.
- **The compiler is the index.** Symbol lookups go through `workspace/symbol` on the live server. There is no side database to build, warm, or invalidate.
- **Disk truth.** Before every request the target file is re-read from disk and synced to the server, so results reflect the latest edits regardless of who made them.
- **Lazy lifecycle.** The LSP process starts on the first tool call and is restarted if it crashes.

## How it relates to existing tools

Several projects bridge MCP to language servers. Which one fits depends on the repository and the agent; ts-lsp-mcp was built for a specific case.

- **[mcp-language-server](https://github.com/isaacphi/mcp-language-server)** (isaacphi, Go) is the best-known generic MCP↔LSP proxy: point it at any stdio language server and get definition, references, rename, and diagnostics. For TypeScript it drives the Node-based `typescript-language-server`, so it inherits tsserver-era startup and query latency, and its tools take file/line/column positions — the agent has to grep first to find them. It also includes rename, a write operation. A fork (t3ta) manages multiple language servers in one process for polyglot repos. If your repo mixes languages, this family is the right shape; ts-lsp-mcp deliberately is not.
- **[lsmcp](https://github.com/mizchi/lsmcp)** (mizchi) is the nearest neighbor. It is multi-language with a pluggable `--bin`, and it already supports `tsgo` (the TS7 native preview) as a backend — if you want TS7-native queries plus other languages behind one server, use lsmcp. The differences are architectural: lsmcp requires Node 22+ and maintains its own index/overview layer (project overview, symbol search backed by SQLite); ts-lsp-mcp is a thinner single-language bridge (Node ≥ 18.17) that treats the compiler's own semantic index as the only source of truth, and spends its effort on query ergonomics (symbol-by-name targeting, disambiguation, misposition detection) instead of an index.
- **[Serena](https://github.com/oraios/serena)** (Oraios) is a full agent toolkit rather than a bridge: symbol-level retrieval plus symbolic *editing* (replace symbol body, cross-file rename/move), 40+ languages, Python/uv runtime. If you want the agent to perform refactors through semantic tools, Serena is the serious option — nothing here competes with that. The tradeoffs are a much larger tool surface for the model to learn, a heavier runtime, and (for TS) the legacy language server underneath.
- **[agent-lsp](https://www.agent-lsp.com/)** is a stateful multi-language runtime: it indexes the workspace once, keeps servers warm, routes files by extension across ~30 languages, and layers workflow tooling on top. Again a good fit for polyglot setups; again the legacy TS server underneath.
- **Raw LSP wrappers** ([Tritlo/lsp-mcp](https://github.com/tritlo/lsp-mcp), jonrad/lsp-mcp, and similar) expose LSP requests more or less directly — hover, completions, code actions, explicit server start. Maximum generality, minimum ergonomics: the agent manages positions, document lifecycle, and sometimes server startup itself.

What ts-lsp-mcp does that the above do not, in combination:

- **Built on `tsc --lsp` specifically.** TypeScript 7.0 ships no programmatic API (planned for 7.1); the LSP is the supported integration surface, and the Go compiler answers these queries in milliseconds where tsserver took seconds on large projects. Binary resolution and version gating (rejecting a TS ≤ 6 `tsc`, which has no `--lsp` flag) are handled here rather than left to the user.
- **Symbol-by-name targeting with disambiguation.** Every navigation tool accepts a bare `symbol` name, resolved through the compiler's semantic index. Ambiguous names return a disambiguation list; unknown names return close matches. Position-based bridges require a grep-then-position two-step for the most common agent question ("where is X defined / used").
- **Misposition detection.** Positional queries echo the identifier actually found under the position, so an off-by-a-few column guess produces a visibly wrong symbol name instead of a silently wrong answer.
- **Read-only by design**, which matters if you want semantic navigation without adding a second write path outside the agent's normal, reviewable file edits.

And what it deliberately does not do: multiple languages, multiple roots per instance, editing/refactoring, completions (an agent writing whole edits has little use for cursor completions), or embedded languages — see limitations below.

## When it makes sense

Use ts-lsp-mcp when all of these hold:

1. The project is plain TypeScript/JavaScript (`.ts/.tsx/.js/.jsx`) and can adopt TypeScript 7.
2. The agent's failure mode you care about is navigation — answering "who calls this", "what type is this", "does this still type-check" from grep and guesswork.
3. You want those answers from the compiler without giving the agent a semantic write path.

Reach for something else when: the repo is polyglot (lsmcp, agent-lsp, or the mcp-language-server fork), you want semantic refactoring tools (Serena), you're stuck on TS ≤ 6 or need Vue/Svelte/Astro support (any tsserver-based bridge), or your host already provides equivalent built-in code intelligence.

Companion project: [ts-header-mcp](../ts-header-mcp) solves the adjacent problem — cheap whole-file/project *orientation* via header-style signature listings. The two compose: headers to find the right place, this server for precise questions once there.

## Tools

| Tool | What it does |
| --- | --- |
| `ts_definition` | Go to definition — by `symbol` name or `file`/`line`/`column` |
| `ts_type_definition` | Jump to the *type's* declaration |
| `ts_implementations` | Find implementations of an interface/abstract member |
| `ts_references` | All references project-wide (follows aliased imports; no comment/string false positives) |
| `ts_hover` | Inferred type + JSDoc for a symbol |
| `ts_document_symbols` | Outline of a file (declaration-level by default; `depth: "all"` for locals) |
| `ts_workspace_symbols` | Fuzzy symbol search across the project |
| `ts_diagnostics` | Type-check a file; errors with code context |
| `ts_server_info` | Which TS binary/version is in use |

All positions are 1-based (line and column), matching what editors and models display.

### Targeting symbols by name

Every navigation tool accepts either a name or an exact position:

```jsonc
{ "symbol": "offerSpotToWaitlist" }             // one call, no position needed
{ "symbol": "process", "file": "src/queue.ts" } // disambiguate same-named symbols
{ "file": "src/queue.ts", "line": 42, "column": 10 } // exact occurrence
```

### Output conventions

Three conventions exist because of observed agent failure modes:

- Positional queries echo the resolved identifier (`124 reference(s) to 'internal' (symbol at …)`), making a mispositioned query visible.
- Reference results lead with a per-file tally. When every reference lands in a single file, the output notes that codegen or proxy indirection (e.g. framework-generated API namespaces) may hide cross-file usages and suggests a text-search cross-check, since a confidently incomplete reference list is worse than none.
- Results end with `//`-prefixed next-step hints (`// callers: ts_references({symbol: "…"})`), so the follow-up call is spelled out rather than left to tool-selection luck.

## Requirements

- Node.js ≥ 18.17 (to run this server)
- TypeScript 7 available for the *target* project — any of:
  - `npm install -D typescript@^7` in that project (recommended), or
  - `npm install -g @typescript/native-preview` (provides `tsgo`), or
  - an explicit binary via `--lsp-path` / `TS_LSP_SERVER_PATH`

Binary resolution order: explicit path → project-local `node_modules/.bin/tsc` (v7+) → project-local `tsgo` → `tsgo` on PATH → `tsc` on PATH (v7+). A TypeScript ≤ 6 `tsc` is rejected with an explanatory error (it has no `--lsp` flag).

## Install & build

```bash
cd ts-lsp-mcp
npm install
npm run build

# sanity check against a real project:
node dist/index.js --root /path/to/your/ts/project --self-test
```

`--self-test` resolves the binary, performs an LSP handshake, and exits — run it once per project before wiring up a host, so configuration problems surface as a readable error rather than a silent tool failure inside the agent.

## Hooking it up

### Claude Code

```bash
claude mcp add ts-lsp -- node /abs/path/to/ts-lsp-mcp/dist/index.js --root /abs/path/to/your/project
```

Or in `.mcp.json` at your project root (`--root` can then be omitted, since cwd is the project):

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

### VS Code (`.vscode/mcp.json`)

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

### Other MCP hosts

Any host that supports stdio MCP servers works the same way: configure the command as `node /abs/path/to/ts-lsp-mcp/dist/index.js --root <projectDir>`. Consult your host's documentation for where its `mcp.json` (or equivalent) lives.

## Configuration reference

| Flag | Env var | Meaning |
| --- | --- | --- |
| `--root <dir>` | `TS_LSP_PROJECT_ROOT` | Project root (default: cwd) |
| `--lsp-path <bin>` | `TS_LSP_SERVER_PATH` | Explicit TS 7 binary (`tsc` or `tsgo`) |
| `--self-test` | — | Resolve binary, do an LSP handshake, exit |

## Limitations

- **Single language, single root.** Files outside `--root` are rejected. Polyglot repos need one instance per project, or one of the multi-language bridges above.
- **Embedded languages are unsupported.** Vue SFCs, Svelte, Astro, MDX, and Angular templates depend on the TypeScript 6 API and are not handled by TS7's language server yet. Plain `.ts/.tsx/.js/.jsx` is fully supported.
- **Columns are UTF-16 code units** (the LSP default). For ordinary code this matches character counts; lines containing emoji or astral characters may be off by the code-unit difference.
- **No programmatic-API fallback.** TypeScript 7.0 ships no compiler API (planned for 7.1); anything the LSP does not expose, this server cannot expose either.

## Development

```bash
npm run dev          # run from source via tsx
npm run build        # compile with the TS7 tsc
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
