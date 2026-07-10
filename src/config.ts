import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface ServerCommand {
  command: string;
  args: string[];
  /** Human-readable description of how the binary was found. */
  source: string;
  /** Reported version string, if we could determine one. */
  version?: string;
}

export interface ResolveOptions {
  projectRoot: string;
  /** Explicit binary path (from --lsp-path or TS_LSP_SERVER_PATH). */
  explicitPath?: string;
}

function tryVersion(bin: string): string | undefined {
  try {
    const res = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (res.status !== 0) return undefined;
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const m = /Version\s+([\d.]+\S*)/i.exec(out) ?? /([\d]+\.[\d.]+\S*)/.exec(out);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function majorOf(version: string | undefined): number | null {
  if (!version) return null;
  const m = /^(\d+)\./.exec(version);
  return m ? parseInt(m[1], 10) : null;
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `start` looking for node_modules/.bin/<name>. */
function findInNodeModules(start: string, name: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the TypeScript native LSP server command.
 *
 * TypeScript 7.0 ships the Go-native compiler as the `tsc` executable in the
 * `typescript` npm package; the language server is started with
 * `tsc --lsp --stdio`. The nightly/preview package exposed the same binary as
 * `tsgo`. A `tsc` from TypeScript <= 6 does NOT understand `--lsp`, so every
 * candidate is version-checked (major >= 7) before being accepted.
 *
 * Resolution order:
 *   1. explicitPath (trusted, but version-verified with a warning)
 *   2. <projectRoot>/**\/node_modules/.bin/tsc   (must be v7+)
 *   3. <projectRoot>/**\/node_modules/.bin/tsgo  (native preview)
 *   4. `tsgo` on PATH
 *   5. `tsc` on PATH (must be v7+)
 */
export function resolveLspServer(opts: ResolveOptions): ServerCommand {
  const lspArgs = ["--lsp", "--stdio"];
  const problems: string[] = [];

  if (opts.explicitPath) {
    const version = tryVersion(opts.explicitPath);
    const major = majorOf(version);
    if (major !== null && major < 7) {
      throw new Error(
        `Explicit LSP binary '${opts.explicitPath}' reports version ${version}, ` +
          `but TypeScript >= 7 is required for '--lsp' support.`,
      );
    }
    return {
      command: opts.explicitPath,
      args: lspArgs,
      source: "explicit path (--lsp-path / TS_LSP_SERVER_PATH)",
      version,
    };
  }

  // 2. project-local tsc (TypeScript 7 stable)
  const localTsc = findInNodeModules(opts.projectRoot, "tsc");
  if (localTsc) {
    const version = tryVersion(localTsc);
    if ((majorOf(version) ?? 0) >= 7) {
      return {
        command: localTsc,
        args: lspArgs,
        source: "project-local node_modules/.bin/tsc",
        version,
      };
    }
    problems.push(
      `found project-local tsc (${localTsc}) but it is version ${version ?? "unknown"} (< 7)`,
    );
  }

  // 3. project-local tsgo (@typescript/native-preview)
  const localTsgo = findInNodeModules(opts.projectRoot, "tsgo");
  if (localTsgo) {
    return {
      command: localTsgo,
      args: lspArgs,
      source: "project-local node_modules/.bin/tsgo (native preview)",
      version: tryVersion(localTsgo),
    };
  }

  // 4. tsgo on PATH
  const pathTsgoVersion = tryVersion("tsgo");
  if (pathTsgoVersion !== undefined) {
    return {
      command: "tsgo",
      args: lspArgs,
      source: "tsgo on PATH",
      version: pathTsgoVersion,
    };
  }

  // 5. tsc on PATH, if it's v7+
  const pathTscVersion = tryVersion("tsc");
  if ((majorOf(pathTscVersion) ?? 0) >= 7) {
    return {
      command: "tsc",
      args: lspArgs,
      source: "tsc on PATH",
      version: pathTscVersion,
    };
  }
  if (pathTscVersion) {
    problems.push(`tsc on PATH is version ${pathTscVersion} (< 7)`);
  }

  throw new Error(
    "Could not find a TypeScript 7 language server binary.\n" +
      (problems.length ? `Notes: ${problems.join("; ")}\n` : "") +
      "Fix by one of:\n" +
      `  - npm install -D typescript@^7 in the target project (${opts.projectRoot})\n` +
      "  - npm install -g @typescript/native-preview  (provides `tsgo`)\n" +
      "  - pass --lsp-path /abs/path/to/tsc-or-tsgo, or set TS_LSP_SERVER_PATH",
  );
}
