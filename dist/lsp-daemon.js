#!/usr/bin/env node

// src/lsp-daemon.ts
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { unlinkSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
var MessageParser = class {
  buffer = Buffer.alloc(0);
  contentLength = -1;
  headerComplete = false;
  onMessage;
  constructor(onMessage) {
    this.onMessage = onMessage;
  }
  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.parse();
  }
  parse() {
    while (true) {
      if (!this.headerComplete) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.headerComplete = true;
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }
      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.headerComplete = false;
      try {
        const msg = JSON.parse(body);
        this.onMessage(msg);
      } catch {
      }
    }
  }
};
function encodeMessage(msg) {
  const body = JSON.stringify(msg);
  const bodyBytes = Buffer.byteLength(body, "utf-8");
  const header = `Content-Length: ${bodyBytes}\r
\r
`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf-8")]);
}
var args = process.argv.slice(2);
var socketPath = args[0];
var lspCommand = args[1];
var lspArgs = args.slice(2);
var rootDir = process.env.LSP_ROOT_DIR || process.cwd();
var languageId = process.env.LSP_LANGUAGE_ID || "unknown";
var workspaceFoldersJson = process.env.LSP_WORKSPACE_FOLDERS;
var initializationOptionsJson = process.env.LSP_INITIALIZATION_OPTIONS;
var settingsJson = process.env.LSP_SETTINGS;
if (!socketPath || !lspCommand) {
  console.error("Usage: lsp-daemon.js <socketPath> <command> [args...]");
  process.exit(1);
}
var nextClientId = 1;
var nextDaemonRequestId = 1;
var clients = /* @__PURE__ */ new Map();
var pendingRequests = /* @__PURE__ */ new Map();
var pendingServerRequests = /* @__PURE__ */ new Map();
var settings;
var shutdownTimer = null;
var server;
var lspProcess;
var lspParser;
var lspInitialized = false;
var initRequestId = null;
var initResolve = null;
var initReject = null;
function spawnLspServer() {
  const child = spawn(lspCommand, lspArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: rootDir,
    env: process.env
  });
  child.stderr?.resume();
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
function clientToServer(clientId, msg) {
  if (!lspProcess.stdin?.writable) return;
  if (msg.id !== void 0 && msg.method) {
    const daemonId = nextDaemonRequestId++;
    pendingRequests.set(daemonId, { clientId, originalId: msg.id });
    const rewritten = { ...msg, id: daemonId };
    lspProcess.stdin.write(encodeMessage(rewritten));
  } else if (msg.id !== void 0 && !msg.method) {
    if (pendingServerRequests.has(msg.id)) {
      pendingServerRequests.delete(msg.id);
      lspProcess.stdin.write(encodeMessage(msg));
    }
  } else {
    lspProcess.stdin.write(encodeMessage(msg));
  }
}
function handleServerMessage(msg) {
  if (!lspInitialized) {
    if (initRequestId !== null && msg.id === initRequestId && !msg.method) {
      lspInitialized = true;
      initRequestId = null;
      lspProcess.stdin.write(encodeMessage({
        jsonrpc: "2.0",
        method: "initialized",
        params: {}
      }));
      log(`LSP server initialized (${languageId})`);
      initResolve?.();
      initResolve = null;
      initReject = null;
    }
    return;
  }
  serverToClients(msg);
}
function serverToClients(msg) {
  if (msg.id !== void 0 && !msg.method) {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      const client = clients.get(pending.clientId);
      if (client && !client.socket.destroyed) {
        const rewritten = { ...msg, id: pending.originalId };
        client.socket.write(encodeMessage(rewritten));
      }
    }
  } else if (msg.id !== void 0 && msg.method) {
    handleServerRequest(msg);
  } else if (msg.method && msg.id === void 0) {
    const encoded = encodeMessage(msg);
    for (const client of clients.values()) {
      if (!client.socket.destroyed) {
        client.socket.write(encoded);
      }
    }
  }
}
function handleServerRequest(msg) {
  if (msg.method === "workspace/configuration") {
    const params = msg.params;
    const items = params?.items ?? [];
    const result = items.map((item) => {
      if (item.section && settings && item.section in settings) {
        return settings[item.section];
      }
      return {};
    });
    const response = { jsonrpc: "2.0", id: msg.id, result };
    lspProcess.stdin.write(encodeMessage(response));
    return;
  }
  const firstClient = getFirstConnectedClient();
  if (firstClient) {
    pendingServerRequests.set(msg.id, firstClient.id);
    firstClient.socket.write(encodeMessage(msg));
  } else {
    const errorResponse = {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32001, message: "No clients connected to handle request" }
    };
    lspProcess.stdin.write(encodeMessage(errorResponse));
  }
}
function getFirstConnectedClient() {
  for (const client of clients.values()) {
    if (!client.socket.destroyed) return client;
  }
  return void 0;
}
async function initializeLsp() {
  return new Promise((resolve, reject) => {
    const rootUri = pathToFileURL(rootDir).toString();
    let workspaceFolders = [{ uri: rootUri, name: rootDir.split("/").pop() ?? "workspace" }];
    if (workspaceFoldersJson) {
      try {
        const parsed = JSON.parse(workspaceFoldersJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          workspaceFolders = parsed;
        }
      } catch {
      }
    }
    let initializationOptions;
    if (initializationOptionsJson) {
      try {
        initializationOptions = JSON.parse(initializationOptionsJson);
      } catch {
      }
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
          completion: { completionItem: { snippetSupport: false } }
        },
        workspace: { workspaceFolders: true, symbol: {}, configuration: true }
      },
      rootUri,
      workspaceFolders,
      ...initializationOptions ? { initializationOptions } : {}
    };
    initResolve = resolve;
    initReject = reject;
    initRequestId = nextDaemonRequestId++;
    const initRequest = {
      jsonrpc: "2.0",
      id: initRequestId,
      method: "initialize",
      params: initParams
    };
    lspProcess.stdin.write(encodeMessage(initRequest));
    setTimeout(() => {
      if (!lspInitialized) {
        initResolve = null;
        initReject = null;
        reject(new Error("LSP initialize timed out after 5 minutes"));
      }
    }, 5 * 6e4);
  });
}
function startSocketServer() {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
    }
  }
  const srv = createServer((socket) => {
    const clientId = nextClientId++;
    log(`Client ${clientId} connected`);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    const parser = new MessageParser((msg) => {
      clientToServer(clientId, msg);
    });
    const conn = { id: clientId, socket, parser };
    clients.set(clientId, conn);
    socket.on("data", (data) => parser.feed(Buffer.from(data)));
    socket.on("close", () => {
      log(`Client ${clientId} disconnected`);
      clients.delete(clientId);
      for (const [reqId, pending] of pendingRequests) {
        if (pending.clientId === clientId) {
          pendingRequests.delete(reqId);
        }
      }
      if (clients.size === 0) {
        log("No clients remaining, will shut down in 5 minutes");
        shutdownTimer = setTimeout(() => shutdown(0), 5 * 60 * 1e3);
      }
    });
    socket.on("error", (err) => {
      log(`Client ${clientId} error: ${err.message}`);
      clients.delete(clientId);
    });
  });
  srv.listen(socketPath, () => {
    log(`Listening on ${socketPath}`);
    const pidPath = socketPath.replace(/\.sock$/, ".pid");
    writeFileSync(pidPath, String(process.pid));
  });
  srv.on("error", (err) => {
    log(`Socket server error: ${err.message}`);
    shutdown(1);
  });
  return srv;
}
function log(msg) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const logPath = socketPath.replace(/\.sock$/, ".log");
  try {
    appendFileSync(logPath, `[${ts}] ${msg}
`);
  } catch {
  }
}
function shutdown(code) {
  log("Shutting down daemon");
  if (shutdownTimer) clearTimeout(shutdownTimer);
  for (const client of clients.values()) {
    client.socket.destroy();
  }
  clients.clear();
  if (lspProcess && !lspProcess.killed) {
    try {
      lspProcess.stdin?.write(encodeMessage({
        jsonrpc: "2.0",
        id: nextDaemonRequestId++,
        method: "shutdown",
        params: null
      }));
      setTimeout(() => {
        lspProcess.stdin?.write(encodeMessage({
          jsonrpc: "2.0",
          method: "exit",
          params: null
        }));
        setTimeout(() => {
          if (!lspProcess.killed) lspProcess.kill("SIGTERM");
        }, 1e3);
      }, 2e3);
    } catch {
      lspProcess.kill("SIGTERM");
    }
  }
  try {
    unlinkSync(socketPath);
  } catch {
  }
  try {
    unlinkSync(socketPath.replace(/\.sock$/, ".pid"));
  } catch {
  }
  if (server) server.close();
  setTimeout(() => process.exit(code), 3e3);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}
${err.stack ?? ""}`);
  shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason}`);
  shutdown(1);
});
async function main() {
  log(`Starting daemon: ${lspCommand} ${lspArgs.join(" ")} (${languageId})`);
  if (settingsJson) {
    try {
      settings = JSON.parse(settingsJson);
    } catch (e) {
      log(`Warning: failed to parse LSP_SETTINGS: ${e}`);
    }
  }
  lspProcess = spawnLspServer();
  lspParser = new MessageParser(handleServerMessage);
  lspProcess.stdout.on("data", (data) => lspParser.feed(data));
  server = startSocketServer();
  try {
    await initializeLsp();
  } catch (err) {
    log(`Failed to initialize LSP server: ${err.message}`);
    shutdown(1);
  }
}
main().catch((err) => {
  log(`Daemon fatal error: ${err.message}`);
  process.exit(1);
});
