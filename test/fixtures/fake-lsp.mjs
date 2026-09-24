// Minimal LSP server over stdio for tests: answers initialize and hover, null for anything else.
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const handle = ({ id, method, params }) => {
  if (method === "exit") process.exit(0);
  if (id === undefined || !method) return;
  if (method === "initialize") send({ id, result: { capabilities: { hoverProvider: true } } });
  else if (method === "textDocument/hover") {
    const { line, character } = params.position;
    send({ id, result: { contents: { kind: "plaintext", value: `fake hover ${line}:${character}` } } });
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
// LspClient.shutdown() queues `exit` and SIGTERMs at once; like a real server, live on to read it.
process.on("SIGTERM", () => {});
