/**
 * Minimal JSON-RPC 2.0 codec for the LSP base protocol
 * (Content-Length framed messages over a byte stream).
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeMessage(msg: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(
    `Content-Length: ${body.length}\r\n\r\n`,
    "ascii",
  );
  return Buffer.concat([header, body]);
}

/**
 * Incremental parser. Feed it raw chunks from the LSP server's stdout;
 * it invokes `onMessage` once per complete JSON-RPC message.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  constructor(private readonly onMessage: (msg: JsonRpcMessage) => void) {}

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Loop: there may be multiple complete messages in the buffer.
    for (;;) {
      if (this.expectedLength === null) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // wait for more data

        const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!match) {
          // Corrupt header; drop it and resync.
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        this.expectedLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.expectedLength) return; // wait for body

      const body = this.buffer.subarray(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;

      let parsed: JsonRpcMessage | undefined;
      try {
        parsed = JSON.parse(body.toString("utf8")) as JsonRpcMessage;
      } catch {
        // Ignore unparseable body; continue with next frame.
      }
      if (parsed) this.onMessage(parsed);
    }
  }
}
