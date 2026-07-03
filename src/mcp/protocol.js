"use strict";

const { EngineError } = require("../engine/errors");

const PROTOCOL_VERSION = "2025-06-18";

function isNotification(message) {
  return !("id" in message) || message.id === undefined;
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function resultResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

// Tool-level failures (unknown tool, EngineError) are reported inside a
// normal JSON-RPC *result* with isError: true, per MCP's tools/call
// convention — they are not JSON-RPC protocol errors. Anything else
// (a genuine bug) is rethrown so the caller logs it and returns a generic
// message instead of leaking internals.
//
// Every result carries both content (a JSON-stringified text block, for
// clients that only read that) and structuredContent (the same data as a
// real object) — a client that wants the object doesn't have to parse it
// back out of a string.
async function callTool(tools, engine, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const payload = { error: `Unknown tool: ${name}` };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  }
  try {
    const result = await tool.handler(args ?? {}, engine);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (e) {
    if (e instanceof EngineError) {
      const payload = e.toResponse();
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
    }
    throw e;
  }
}

/**
 * Dispatches one parsed JSON-RPC message against the given tool manifest
 * and engine. Returns the response object to send back, or null for
 * notifications (including unrecognised ones, per JSON-RPC convention) —
 * the HTTP layer turns null into 202 Accepted with no body.
 */
async function handleMessage(message, { tools, engine, serverInfo, log }) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return errorResponse(null, -32600, "Invalid Request");
  }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(message.id ?? null, -32600, "Invalid Request");
  }

  const notification = isNotification(message);

  switch (message.method) {
    case "initialize":
      if (notification) return null;
      return resultResponse(message.id, {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: serverInfo.name, version: serverInfo.version },
        instructions: serverInfo.instructions,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return notification ? null : resultResponse(message.id, {});

    case "tools/list":
      return resultResponse(message.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case "tools/call": {
      const { name, arguments: args } = message.params ?? {};
      try {
        const result = await callTool(tools, engine, name, args);
        return notification ? null : resultResponse(message.id, result);
      } catch (e) {
        log?.(`tools/call ${name} failed: ${e.stack ?? e}`);
        const payload = { error: "An internal error occurred." };
        return notification
          ? null
          : resultResponse(message.id, {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
            });
      }
    }

    default:
      return notification ? null : errorResponse(message.id, -32601, `Method not found: ${message.method}`);
  }
}

module.exports = { handleMessage, PROTOCOL_VERSION };
