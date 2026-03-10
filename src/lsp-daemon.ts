#!/usr/bin/env node
/**
 * LSP Daemon — persistent LSP server proxy over Unix domain socket.
 *
 * Spawns an LSP server (stdio) and multiplexes connections from multiple
 * pi sessions via a Unix socket. This avoids running duplicate heavy
 * LSP servers (jdtls, pyright, etc.) across sessions in the same workspace.
 *
 * Protocol: clients connect to the socket and speak JSON-RPC using
 * LSP Content-Length framing — same as talking to an LSP server directly.
 *
 * Lifecycle:
 *   - First session spawns daemon (detached)
 *   - Daemon spawns LSP server, listens on socket
 *   - Sessions connect/disconnect freely
 *   - After last client disconnects, daemon waits 5 min then exits
 *
 * Usage: node lsp-daemon.js <socketPath> <command> [args...]
 *   Env: LSP_ROOT_DIR, LSP_LANGUAGE_ID, LSP_WORKSPACE_FOLDERS (JSON)
 */

import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

// ── LSP Message Framing ────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * Incremental parser for LSP Content-Length framed messages.
 * Accumulates data and emits complete JSON-RPC messages.
 */
class MessageParser {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private headerComplete = false;
  private onMessage: (msg: JsonRpcMessage) => void;

  constructor(onMessage: (msg: JsonRpcMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.parse();
  }

  private parse(): void {
    while (true) {
      if (!this.headerComplete) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // incomplete header

        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header — advance past it
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.headerComplete = true;
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return; // incomplete body

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.headerComplete = false;

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.onMessage(msg);
      } catch {
        // Skip malformed JSON
      }
    }
  }
}

/** Encode a JSON-RPC message with Content-Length header */
function encodeMessage(msg: JsonRpcMessage): Buffer {
  const body = JSON.stringify(msg);
  const bodyBytes = Buffer.byteLength(body, "utf-8");
  const header = `Content-Length: ${bodyBytes}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf-8")]);
}

// ── Client Tracking ────────────────────────────────────────────────────────

interface ClientConnection {
  id: number;
  socket: Socket;
  parser: MessageParser;
}

// ── Main Daemon ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const socketPath = args[0];
const lspCommand = args[1];
const lspArgs = args.slice(2);
const rootDir = process.env.LSP_ROOT_DIR || process.cwd();
const languageId = process.env.LSP_LANGUAGE_ID || "unknown";
const workspaceFoldersJson = process.env.LSP_WORKSPACE_FOLDERS;

if (!socketPath || !lspCommand) {
  console.error("Usage: lsp-daemon.js <socketPath> <command> [args...]");
  process.exit(1);
}

let nextClientId = 1;
let nextDaemonRequestId = 1;
const clients = new Map<number, ClientConnection>();
/** Map daemon request ID → { clientId, originalId } */
const pendingRequests = new Map<number | string, { clientId: number; originalId: number | string }>();
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
let server: Server;
let lspProcess: ChildProcess;
let lspParser: MessageParser;
let lspInitialized = false;
/** Messages received from LSP server before initialization completes */
const pendingServerMessages: JsonRpcMessage[] = [];

// ── Spawn LSP Server ───────────────────────────────────────────────────────

function spawnLspServer(): ChildProcess {
  const child = spawn(lspCommand, lspArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: rootDir,
    env: process.env,
  });

  child.stderr?.resume(); // prevent blocking

  child.on("error", (err) => {
    log(`LSP server error: ${err.message}`);
    shutdown(1);
  });

  child.on("exit", (code) => {
    log(`LSP server exited with code ${code}`);
    shutdown(0);
  });

  return child;
}

// ── Message Routing ────────────────────────────────────────────────────────

/** Forward a message from a client to the LSP server, rewriting request IDs */
function clientToServer(clientId: number, msg: JsonRpcMessage): void {
  if (!lspProcess.stdin?.writable) return;

  if (msg.id !== undefined && msg.method) {
    // Request from client — rewrite ID to track routing
    const daemonId = nextDaemonRequestId++;
    pendingRequests.set(daemonId, { clientId, originalId: msg.id });
    const rewritten = { ...msg, id: daemonId };
    lspProcess.stdin.write(encodeMessage(rewritten));
  } else {
    // Notification from client — forward as-is
    lspProcess.stdin.write(encodeMessage(msg));
  }
}

/** Route a message from the LSP server to the appropriate client(s) */
function serverToClients(msg: JsonRpcMessage): void {
  if (msg.id !== undefined && !msg.method) {
    // Response — route to the client that sent the request
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      const client = clients.get(pending.clientId);
      if (client && !client.socket.destroyed) {
        const rewritten = { ...msg, id: pending.originalId };
        client.socket.write(encodeMessage(rewritten));
      }
    }
  } else if (msg.method && msg.id === undefined) {
    // Notification from server — broadcast to ALL clients
    const encoded = encodeMessage(msg);
    for (const client of clients.values()) {
      if (!client.socket.destroyed) {
        client.socket.write(encoded);
      }
    }
  }
}

// ── Initialize LSP Server ──────────────────────────────────────────────────

async function initializeLsp(): Promise<void> {
  return new Promise((resolve, reject) => {
    const rootUri = pathToFileURL(rootDir).toString();

    let workspaceFolders = [{ uri: rootUri, name: rootDir.split("/").pop() ?? "workspace" }];
    if (workspaceFoldersJson) {
      try {
        const parsed = JSON.parse(workspaceFoldersJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          workspaceFolders = parsed;
        }
      } catch { /* use default */ }
    }

    const initParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: false },
          publishDiagnostics: { relatedInformation: true },
          completion: { completionItem: { snippetSupport: false } },
        },
        workspace: { workspaceFolders: true, symbol: {} },
      },
      rootUri,
      workspaceFolders,
    };

    const requestId = nextDaemonRequestId++;
    const initRequest: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: initParams,
    };

    // Handler for messages during init — looks for our init response
    const processMessage = (msg: JsonRpcMessage) => {
      if (msg.id === requestId && !msg.method) {
        // Got initialize response
        lspInitialized = true;

        // Send initialized notification
        lspProcess.stdin!.write(encodeMessage({
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        }));

        // Drain any remaining queued messages
        while (pendingServerMessages.length > 0) {
          const queued = pendingServerMessages.shift()!;
          serverToClients(queued);
        }

        log(`LSP server initialized (${languageId})`);
        resolve();
      }
      // Other messages during init are queued by the parser callback in main()
    };

    // Process any messages already queued before we sent the init request
    while (pendingServerMessages.length > 0) {
      processMessage(pendingServerMessages.shift()!);
      if (lspInitialized) return;
    }

    // Override parser to use our init handler for new messages
    lspParser = new MessageParser((msg) => {
      if (!lspInitialized) {
        processMessage(msg);
      } else {
        serverToClients(msg);
      }
    });

    lspProcess.stdin!.write(encodeMessage(initRequest));

    // Timeout
    setTimeout(() => {
      if (!lspInitialized) {
        reject(new Error("LSP initialize timed out after 60s"));
      }
    }, 60_000);
  });
}

// ── Socket Server ──────────────────────────────────────────────────────────

function startSocketServer(): Server {
  // Ensure socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // Clean up stale socket
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  const srv = createServer((socket) => {
    const clientId = nextClientId++;
    log(`Client ${clientId} connected`);

    // Cancel shutdown timer
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }

    const parser = new MessageParser((msg) => {
      clientToServer(clientId, msg);
    });

    const conn: ClientConnection = { id: clientId, socket, parser };
    clients.set(clientId, conn);

    socket.on("data", (data) => parser.feed(Buffer.from(data)));

    socket.on("close", () => {
      log(`Client ${clientId} disconnected`);
      clients.delete(clientId);

      // Clean up pending requests for this client
      for (const [reqId, pending] of pendingRequests) {
        if (pending.clientId === clientId) {
          pendingRequests.delete(reqId);
        }
      }

      // Start shutdown timer if no clients remain
      if (clients.size === 0) {
        log("No clients remaining, will shut down in 5 minutes");
        shutdownTimer = setTimeout(() => shutdown(0), 5 * 60 * 1000);
      }
    });

    socket.on("error", (err) => {
      log(`Client ${clientId} error: ${err.message}`);
      clients.delete(clientId);
    });
  });

  srv.listen(socketPath, () => {
    log(`Listening on ${socketPath}`);
    // Write PID file
    const pidPath = socketPath.replace(/\.sock$/, ".pid");
    writeFileSync(pidPath, String(process.pid));
  });

  srv.on("error", (err) => {
    log(`Socket server error: ${err.message}`);
    shutdown(1);
  });

  return srv;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  const logPath = socketPath.replace(/\.sock$/, ".log");
  try {
    appendFileSync(logPath, `[${ts}] ${msg}\n`);
  } catch { /* ignore */ }
}

function shutdown(code: number): void {
  log("Shutting down daemon");

  if (shutdownTimer) clearTimeout(shutdownTimer);

  // Close all client connections
  for (const client of clients.values()) {
    client.socket.destroy();
  }
  clients.clear();

  // Shut down LSP server
  if (lspProcess && !lspProcess.killed) {
    try {
      lspProcess.stdin?.write(encodeMessage({
        jsonrpc: "2.0",
        id: nextDaemonRequestId++,
        method: "shutdown",
        params: null,
      }));
      setTimeout(() => {
        lspProcess.stdin?.write(encodeMessage({
          jsonrpc: "2.0",
          method: "exit",
          params: null,
        }));
        setTimeout(() => {
          if (!lspProcess.killed) lspProcess.kill("SIGTERM");
        }, 1000);
      }, 2000);
    } catch {
      lspProcess.kill("SIGTERM");
    }
  }

  // Clean up socket and PID files
  try { unlinkSync(socketPath); } catch { /* ignore */ }
  try { unlinkSync(socketPath.replace(/\.sock$/, ".pid")); } catch { /* ignore */ }

  if (server) server.close();

  setTimeout(() => process.exit(code), 3000);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ── Start ──────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting daemon: ${lspCommand} ${lspArgs.join(" ")} (${languageId})`);

  lspProcess = spawnLspServer();

  // Set up stdout listener immediately to avoid losing data before init
  lspParser = new MessageParser((msg) => {
    if (!lspInitialized) {
      // Queue messages during initialization — initializeLsp will handle them
      pendingServerMessages.push(msg);
    } else {
      serverToClients(msg);
    }
  });
  lspProcess.stdout!.on("data", (data) => lspParser.feed(data));

  server = startSocketServer();

  try {
    await initializeLsp();
  } catch (err: any) {
    log(`Failed to initialize LSP server: ${err.message}`);
    shutdown(1);
  }
}

main().catch((err) => {
  log(`Daemon fatal error: ${err.message}`);
  process.exit(1);
});
