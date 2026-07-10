import * as path from "node:path";
import { resolveLspServer, type ServerCommand } from "./config.js";
import { LspClient } from "./lsp/client.js";
import { DocumentManager } from "./lsp/documents.js";

export interface SessionOptions {
  projectRoot: string;
  explicitLspPath?: string;
  log: (line: string) => void;
}

/**
 * Owns the LSP client + document state, and transparently restarts the
 * server if it crashed between tool calls.
 */
export class Session {
  private client: LspClient | null = null;
  private docs: DocumentManager | null = null;
  private starting: Promise<void> | null = null;
  serverCommand: ServerCommand | null = null;

  constructor(private readonly opts: SessionOptions) {}

  private async startFresh(): Promise<void> {
    const cmd = this.serverCommand ?? resolveLspServer({
      projectRoot: this.opts.projectRoot,
      explicitPath: this.opts.explicitLspPath,
    });
    this.serverCommand = cmd;
    const client = new LspClient(
      cmd.command,
      cmd.args,
      this.opts.projectRoot,
      this.opts.log,
    );
    await client.start();
    this.client = client;
    this.docs = new DocumentManager(client);
  }

  async ensure(): Promise<{ client: LspClient; docs: DocumentManager }> {
    if (this.client?.isRunning && this.docs) {
      return { client: this.client, docs: this.docs };
    }
    if (!this.starting) {
      this.starting = this.startFresh().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    if (!this.client || !this.docs) {
      throw new Error("Failed to start TypeScript LSP server");
    }
    return { client: this.client, docs: this.docs };
  }

  resolveFile(file: string): string {
    const abs = path.isAbsolute(file)
      ? file
      : path.resolve(this.opts.projectRoot, file);
    const rel = path.relative(this.opts.projectRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `File '${file}' is outside the project root '${this.opts.projectRoot}'.`,
      );
    }
    return abs;
  }

  get root(): string {
    return this.opts.projectRoot;
  }

  async dispose(): Promise<void> {
    await this.client?.shutdown();
  }
}
