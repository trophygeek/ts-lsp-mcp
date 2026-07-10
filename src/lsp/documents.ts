import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LspClient } from "./client.js";
import { pathToUri } from "../util/position.js";

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

interface OpenDoc {
  uri: string;
  version: number;
  text: string;
}

/**
 * The LSP requires textDocument/didOpen before position-based requests on a
 * file, and the server trusts our in-memory text over disk afterwards. Since
 * the LLM (or the user, or another agent) edits files on disk between calls,
 * we re-read the file before every operation and send didChange when it
 * differs from what the server has.
 */
export class DocumentManager {
  private open = new Map<string, OpenDoc>(); // key: absolute path

  constructor(private readonly client: LspClient) {}

  languageIdFor(absPath: string): string {
    return LANGUAGE_IDS[path.extname(absPath).toLowerCase()] ?? "typescript";
  }

  /** Ensure the server has the current on-disk content of the file open. */
  async ensureOpen(absPath: string): Promise<{ uri: string; text: string }> {
    const text = await fs.readFile(absPath, "utf8");
    const existing = this.open.get(absPath);

    if (!existing) {
      const uri = pathToUri(absPath);
      this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.languageIdFor(absPath),
          version: 1,
          text,
        },
      });
      this.open.set(absPath, { uri, version: 1, text });
      return { uri, text };
    }

    if (existing.text !== text) {
      existing.version += 1;
      existing.text = text;
      this.client.notify("textDocument/didChange", {
        textDocument: { uri: existing.uri, version: existing.version },
        contentChanges: [{ text }], // full-document sync
      });
    }
    return { uri: existing.uri, text: existing.text };
  }

  /** Forget all open documents (used after a server restart). */
  reset(): void {
    this.open.clear();
  }
}
