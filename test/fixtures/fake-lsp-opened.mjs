// Fake LSP server that, like typescript-language-server and kotlin-lsp, only analyzes
// documents the client has opened. FAKE_PULL=1 also advertises pull diagnostics (LSP 3.17);
// FAKE_PULL_FAIL=1 rejects every pull with ServerCancelled (as servers do while indexing).
// Like typescript-language-server it publishes [] on didClose, and it never publishes anything
// for URIs containing "silent" (servers that only report problems).
let buf = Buffer.alloc(0);
const pull = process.env.FAKE_PULL === "1" || process.env.FAKE_PULL_FAIL === "1";
const pullFail = process.env.FAKE_PULL_FAIL === "1";
const docs = new Map();
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const diagnosticsFor = (text) =>
  text.includes("BAD")
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "fake type error", source: "fake" }]
    : [];
const handle = ({ id, method, params }) => {
  if (method === "exit") process.exit(0);
  if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const uri = params.textDocument.uri;
    const text = method === "textDocument/didOpen" ? params.textDocument.text : params.contentChanges[0].text;
    docs.set(uri, text);
    if (!pull && !uri.includes("silent")) setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(text) } }), 300);
    return;
  }
  if (method === "textDocument/didClose") {
    docs.delete(params.textDocument.uri);
    if (!pull) send({ method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
    return;
  }
  if (id === undefined || !method) return;
  if (method === "initialize") {
    send({ id, result: { capabilities: { textDocumentSync: 1, ...(pull ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}) } } });
  } else if (method === "textDocument/diagnostic" && pullFail) {
    send({ id, error: { code: -32802, message: "ServerCancelled" } });
  } else if (method === "textDocument/diagnostic") {
    const text = docs.get(params.textDocument.uri);
    send({ id, result: { kind: "full", items: text === undefined ? [] : diagnosticsFor(text) } });
  } else send({ id, result: null });
};
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    handle(JSON.parse(buf.subarray(end + 4, end + 4 + len).toString()));
    buf = buf.subarray(end + 4 + len);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => {});
