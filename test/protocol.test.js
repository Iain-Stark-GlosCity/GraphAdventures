"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handleMessage } = require("../src/mcp/protocol");
const { buildTools } = require("../src/mcp/tools");
const { adventure, makeEngine } = require("./helpers");

const SERVER_INFO = { name: "rust-wind-hills", version: adventure.version, instructions: "play the game" };

function ctx() {
  const { engine } = makeEngine();
  return { tools: buildTools(adventure.id), engine, serverInfo: SERVER_INFO, log: () => {} };
}

test("initialize returns protocol version, tools capability and server info", async () => {
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    ctx()
  );
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.deepEqual(response.result.serverInfo, { name: "rust-wind-hills", version: adventure.version });
  assert.equal(response.result.instructions, SERVER_INFO.instructions);
});

test("initialize notifications get no response", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "initialize" }, ctx()), null);
});

test("notifications/initialized and notifications/cancelled get no response", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx()), null);
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled" }, ctx()), null);
});

test("ping replies with an empty result", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, ctx());
  assert.deepEqual(response, { jsonrpc: "2.0", id: 2, result: {} });
});

test("tools/list returns all four tools with input schemas, no handlers leaked", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx());
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_log", "get_node", "new_run", "walk"]);
  for (const tool of response.result.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
  }
  const walk = response.result.tools.find((t) => t.name === "walk");
  assert.deepEqual(walk.inputSchema.required, ["run_id", "route_id", "expected_revision"]);
  assert.equal(walk.inputSchema.properties.expected_revision.type, "number");
});

test("tools/call drives new_run then walk through the real engine end to end", async () => {
  const c = ctx();
  const newRunResp = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "new_run", arguments: { adventure_id: adventure.id } },
    },
    c
  );
  assert.equal(newRunResp.result.isError, undefined);
  const payload = JSON.parse(newRunResp.result.content[0].text);
  assert.equal(payload.node.id, "barrowgate_square");

  const walkResp = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "walk",
        arguments: { run_id: payload.run_id, route_id: "r001", expected_revision: 0 },
      },
    },
    c
  );
  const step = JSON.parse(walkResp.result.content[0].text);
  assert.equal(step.to, "bent_nail_inn");

  // structuredContent carries the same data as a real object, not just
  // packed into the text block a client would otherwise have to re-parse.
  assert.deepEqual(newRunResp.result.structuredContent, payload);
  assert.deepEqual(walkResp.result.structuredContent, step);
});

test("tools/call error results also carry structuredContent, not just text", async () => {
  const response = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_node", arguments: { run_id: "no-such-run" } },
    },
    ctx()
  );
  assert.equal(response.result.isError, true);
  const fromText = JSON.parse(response.result.content[0].text);
  assert.deepEqual(response.result.structuredContent, fromText);
  assert.equal(response.result.structuredContent.code, "run_not_found");
});

test("tools/call surfaces an EngineError as a tool result with isError, not a JSON-RPC error", async () => {
  const response = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_node", arguments: { run_id: "no-such-run" } },
    },
    ctx()
  );
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.code, "run_not_found");
});

test("tools/call with an unknown tool name is a tool error, not a protocol error", async () => {
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "delete_universe", arguments: {} } },
    ctx()
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Unknown tool/);
});

test("an unknown method is a JSON-RPC method-not-found error", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 8, method: "wat" }, ctx());
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
});

test("an unknown notification method is silently dropped, not errored", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", method: "notifications/wat" }, ctx());
  assert.equal(response, null);
});

test("malformed requests are rejected as Invalid Request", async () => {
  assert.equal((await handleMessage({ id: 9, method: "ping" }, ctx())).error.code, -32600);
  assert.equal((await handleMessage({ jsonrpc: "1.0", id: 10, method: "ping" }, ctx())).error.code, -32600);
  assert.equal((await handleMessage([{ jsonrpc: "2.0" }], ctx())).error.code, -32600);
  assert.equal((await handleMessage(null, ctx())).error.code, -32600);
  assert.equal((await handleMessage("not an object", ctx())).error.code, -32600);
});
