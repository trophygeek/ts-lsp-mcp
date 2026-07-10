#!/usr/bin/env node
/**
 * ts-lsp-mcp — MCP server bridging the TypeScript 7 native LSP
 * (`tsc --lsp --stdio`) to coding LLMs.
 *
 * Usage:
 *   ts-lsp-mcp [--root <projectDir>] [--lsp-path <binary>]
 *   ts-lsp-mcp --self-test        # verify binary resolution + handshake
 *
 * Env vars (lower precedence than flags):
 *   TS_LSP_PROJECT_ROOT, TS_LSP_SERVER_PATH
 *
 * NOTE: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Session, registerTools } from "./mcp/server.js";

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function parseArgs(argv: string[]): {
  root: string;
  lspPath?: string;
  selfTest: boolean;
} {
  let root = process.env.TS_LSP_PROJECT_ROOT ?? process.cwd();
  let lspPath = process.env.TS_LSP_SERVER_PATH;
  let selfTest = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      root = argv[++i];
    } else if (arg === "--lsp-path" && argv[i + 1]) {
      lspPath = argv[++i];
    } else if (arg === "--self-test") {
      selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      log("Usage: ts-lsp-mcp [--root <projectDir>] [--lsp-path <binary>] [--self-test]");
      process.exit(0);
    }
  }

  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    log(`Error: project root '${root}' is not a directory.`);
    process.exit(1);
  }
  return { root, lspPath, selfTest };
}

async function main(): Promise<void> {
  const { root, lspPath, selfTest } = parseArgs(process.argv.slice(2));

  const session = new Session({
    projectRoot: root,
    explicitLspPath: lspPath,
    log,
  });

  if (selfTest) {
    log(`Self-test: resolving TypeScript LSP for root ${root} ...`);
    await session.ensure();
    const cmd = session.serverCommand;
    log(`OK: ${cmd?.command} ${cmd?.args.join(" ")}`);
    log(`    via ${cmd?.source}, version ${cmd?.version ?? "unknown"}`);
    await session.dispose();
    log("Self-test passed: LSP handshake completed.");
    process.exit(0);
  }

  const server = new McpServer({ name: "ts-lsp-mcp", version: "0.3.0" });
  registerTools(server, session);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ts-lsp-mcp ready (root: ${root}). LSP starts lazily on first tool call.`);

  const cleanup = async () => {
    await session.dispose();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
