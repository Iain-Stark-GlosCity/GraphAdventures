"use strict";

const path = require("node:path");
const { app } = require("@azure/functions");

const { loadAdventure } = require("../engine/adventure");
const { createEngine } = require("../engine/engine");
const { BlobRunStore } = require("../storage/blobRunStore");
const { buildTools } = require("../mcp/tools");
const { handleMessage } = require("../mcp/protocol");

// Static asset is loaded, hashed and validated once at startup; a broken
// asset fails the host rather than failing mid-game.
const assetPath =
  process.env.ADVENTURE_ASSET_PATH ??
  path.join(__dirname, "..", "..", "rust_wind_hills_adventure_knowledge_graph.json");
const adventure = loadAdventure(assetPath);

const connectionString =
  process.env.ADVENTURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
if (!connectionString) {
  throw new Error(
    "No storage connection string: set ADVENTURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage."
  );
}
const store = new BlobRunStore(connectionString);

const tools = buildTools(adventure.id);

const SERVER_INFO = {
  name: "rust-wind-hills",
  version: adventure.version,
  instructions:
    `Runs the Rust Wind Hills dungeon adventure (adventure_id: ${adventure.id}). Start with ` +
    "new_run to get a run_id, then loop: get_node to read the current node, player state and " +
    "available_routes, then walk with a route id and the revision get_node returned. Narrate " +
    "node read_aloud/summary text to the player and offer the available routes; never invent " +
    "routes. walk returns the committed step including dice/combat resolution and state_after; " +
    "if it returns route_unavailable or a revision conflict, re-fetch with get_node and continue " +
    "from there. When status is completed, call get_node once more to narrate the ending; " +
    "get_log returns the full step history.",
};

// A single, plain HTTP endpoint that speaks MCP's JSON-RPC 2.0 protocol
// directly (initialize / tools/list / tools/call), with every tool
// consolidated under this one URL. Anonymous auth — no function key,
// no Azure Functions MCP-extension system route. This mirrors the
// Difference Engine / llm-library Functions apps' wiring pattern.
app.http("mcp", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "mcp",
  handler: async (request, context) => {
    let message;
    try {
      message = await request.json();
    } catch {
      return {
        status: 400,
        jsonBody: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      };
    }

    const engine = createEngine({ adventure, store, log: (m) => context.log(m) });
    const response = await handleMessage(message, {
      tools,
      engine,
      serverInfo: SERVER_INFO,
      log: (m) => context.log(m),
    });

    if (response === null) {
      return { status: 202 };
    }
    return { status: 200, jsonBody: response };
  },
});

module.exports = { adventure, tools };
