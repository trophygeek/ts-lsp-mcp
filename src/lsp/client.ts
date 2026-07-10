import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { encodeMessage, MessageReader, type JsonRpcMessage } from "./jsonrpc.js";
import { pathToUri } from "../util/position.js";

const REQUEST_TIMEOUT_MS = 60_000;

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1 error, 2 warning, 3 info, 4 hint
  code?: number | string;
  source?: string;
  message: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class LspError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

/** JSON-RPC "method not found". */
export const METHOD_NOT_FOUND = -32601;

export class LspClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private started = false;
  private exited = false;

  /** Latest published diagnostics, keyed by document URI. */
  readonly publishedDiagnostics = new Map<string, LspDiagnostic[]>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly rootPath: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  get isRunning(): boolean {
    return this.started && !this.exited;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.proc = spawn(this.command, this.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const reader = new MessageReader((msg) => this.onMessage(msg));
    this.proc.stdout.on("data", (chunk: Buffer) => reader.feed(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.log(`[lsp stderr] ${chunk.toString("utf8").trimEnd()}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.log(`[lsp] server exited code=${code} signal=${signal}`);
      const err = new LspError(
        `LSP server exited unexpectedly (code=${code}, signal=${signal})`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.emit("exit");
    });
    this.proc.on("error", (err) => {
      this.exited = true;
      this.log(`[lsp] spawn error: ${err.message}`);
      this.emit("exit");
    });

    const rootUri = pathToUri(this.rootPath);
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      clientInfo: { name: "ts-lsp-mcp", version: "0.3.0" },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          symbol: { symbolKind: {} },
        },
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    });
    this.notify("initialized", {});
    this.log(`[lsp] initialized (${this.command} ${this.args.join(" ")})`);
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new LspError(msg.error.message, msg.error.code));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request: answer politely so the server never stalls.
    if (msg.id !== undefined && msg.method !== undefined) {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items =
          (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        result = items.map(() => null);
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }

    // Notification from server
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as {
        uri: string;
        diagnostics: LspDiagnostic[];
      };
      this.publishedDiagnostics.set(params.uri, params.diagnostics ?? []);
      this.emit("diagnostics", params.uri);
      return;
    }
    if (msg.method === "window/logMessage" || msg.method === "window/showMessage") {
      const p = msg.params as { message?: string } | undefined;
      if (p?.message) this.log(`[lsp msg] ${p.message}`);
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.proc || this.exited) {
      throw new LspError("LSP server is not running");
    }
    this.proc.stdin.write(encodeMessage(msg));
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Wait until diagnostics have been published for a URI (or timeout).
   * Returns whatever is stored at that point (possibly undefined).
   */
  waitForPublishedDiagnostics(
    uri: string,
    timeoutMs = 5_000,
  ): Promise<LspDiagnostic[] | undefined> {
    if (this.publishedDiagnostics.has(uri)) {
      return Promise.resolve(this.publishedDiagnostics.get(uri));
    }
    return new Promise((resolve) => {
      const onDiag = (diagUri: string) => {
        if (diagUri !== uri) return;
        cleanup();
        resolve(this.publishedDiagnostics.get(uri));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.publishedDiagnostics.get(uri));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("diagnostics", onDiag);
      };
      this.on("diagnostics", onDiag);
    });
  }

  async shutdown(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      // TS7's Go server is strict: `shutdown`/`exit` must have NO params
      // field. Passing undefined causes JSON.stringify to omit it entirely.
      await this.request("shutdown", undefined, 5_000);
      this.notify("exit", undefined);
    } catch {
      // fall through to kill
    }
    const proc = this.proc;
    setTimeout(() => {
      if (!this.exited) proc.kill("SIGKILL");
    }, 2_000).unref();
  }
}
