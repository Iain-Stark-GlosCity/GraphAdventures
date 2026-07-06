// Talks to the deployed Rust Wind Hills MCP endpoint — the exact same
// POST /api/mcp JSON-RPC 2.0 server an LLM client calls — so a delve played
// through this website and a delve narrated by an LLM are the same run
// engine, the same dice, the same Azure Blob-backed run state. There is no
// local simulation here: every new_run/get_node/walk/get_log call is a real
// network round trip against src/functions/mcp.js.

import { EngineError } from "./engine.mjs";

// The deployed Function App. Overridable with ?endpoint=... (e.g. to point
// at `func start`'s http://localhost:7071/api/mcp during local development).
const DEFAULT_ENDPOINT = "https://func-rust-wind-hills-26487.azurewebsites.net/api/mcp";

function resolveEndpoint() {
  const override = new URLSearchParams(location.search).get("endpoint");
  return override || DEFAULT_ENDPOINT;
}

let nextId = 1;

async function callTool(endpoint, name, args) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (e) {
    throw new EngineError("network_error", `Could not reach the adventure server (${e.message}).`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new EngineError("bad_response", `The adventure server returned an unreadable response (HTTP ${response.status}).`);
  }

  // A JSON-RPC protocol-level error (malformed request, unknown method) —
  // distinct from a tool-level failure, which arrives as a normal result
  // with isError: true instead. See src/mcp/protocol.js.
  if (body.error) {
    throw new EngineError("protocol_error", body.error.message ?? "The adventure server rejected the request.");
  }

  const result = body.result;
  if (result?.isError) {
    // Two payload shapes coexist server-side: an EngineError's
    // { code, message, ...extra } for real tool failures (route_unavailable,
    // run_not_found, revision_conflict, ...), or a bare { error: "..." } for
    // an unknown tool name / unexpected internal error. Handle both.
    const payload = result.structuredContent ?? {};
    throw new EngineError(payload.code ?? "tool_error", payload.message ?? payload.error ?? "That move was rejected.", payload);
  }
  return result?.structuredContent;
}

/**
 * A client for the four MCP tools, shaped for web/app.mjs: newRun/getNode
 * return `status` directly (matching the real server); walk's result also
 * gets a normalised `status` field copied from the server's `status_after`,
 * since the real tool only exposes that name on the persisted step — see
 * README's "Tools" table. Nothing here is a simulation: every call is the
 * live server's answer.
 */
export function createMcpClient(endpoint = resolveEndpoint()) {
  return {
    endpoint,
    newRun: (adventureId, label) => callTool(endpoint, "new_run", { adventure_id: adventureId, label }),
    getNode: (runId) => callTool(endpoint, "get_node", { run_id: runId }),
    async walk(runId, routeId, expectedRevision) {
      const step = await callTool(endpoint, "walk", {
        run_id: runId,
        route_id: routeId,
        expected_revision: expectedRevision,
      });
      return { ...step, status: step.status_after };
    },
    getLog: (runId) => callTool(endpoint, "get_log", { run_id: runId }),
  };
}
