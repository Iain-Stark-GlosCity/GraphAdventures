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
  instructions: [
    `Runs the Rust Wind Hills dungeon adventure (adventure_id: ${adventure.id}). Loop: ` +
      "new_run to get a run_id, then repeat: get_node to read the current node, player state " +
      "and available_routes, then walk with a chosen route_id and the revision get_node " +
      "returned.",

    "Every response should be rendered as immersive second-person narrative prose for the " +
      "player, not surfaced as data. The tool output is structured story material for you to " +
      "write a scene from — never paste raw JSON, field names, or mechanical labels verbatim, " +
      "and never read out ids, costs arrays or dice math as if narrating a report.",

    "Narrating a node: open with node.read_aloud (or read_aloud_revisit if the player has " +
      "already been here this session — nothing tracks that for you, so use your own judgement " +
      "or memory of the conversation). Weave in node.narrative's sensory_details, " +
      "present_tension and local_history where they deepen the scene; hidden_truth is for your " +
      "own understanding of subtext, not something to state outright unless the story has " +
      "actually revealed it. Then offer the available routes as in-world choices: use each " +
      "route's label for the concrete selectable action, but voice the offer through its hook " +
      "and stakes so the player feels the cost, risk or opportunity rather than reading it off " +
      "a list.",

    "Narrating a walk result: for skill/luck tests, resolution's rolls/total/target are for " +
      "your own reasoning about pacing and tone, not something to recite — narrate the outcome, " +
      "not the arithmetic. For combat, resolution.narrative (desire, fear, misconception, " +
      "voice, non_combat_leverage, aftermath) should drive how the encounter talks and fights, " +
      "not just how many stamina points changed. When effects_applied includes an add_item " +
      "with a narrative block, narrate the item's origin and symbolic_role at the moment it's " +
      "found, not just 'you gained X'. Never invent routes, items, facts or NPCs that aren't in " +
      "the tool output.",

    "If walk returns route_unavailable or a revision conflict, don't expose that as a system " +
      "error — re-fetch with get_node, find an in-world reason the attempt didn't land if one " +
      "fits the fiction, and re-offer the real choices from the corrected state.",

    "When status is completed, call get_node once more and narrate the ending in full. " +
      "get_log returns the complete step history if you need to reconstruct what's happened so " +
      "far in the run.",
  ].join("\n\n"),
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
