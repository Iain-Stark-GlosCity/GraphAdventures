"use strict";

const path = require("node:path");
const { app } = require("@azure/functions");

const { loadAdventure, loadAdventures } = require("../engine/adventure");
const { createEngine } = require("../engine/engine");
const { BlobRunStore } = require("../storage/blobRunStore");
const { buildTools } = require("../mcp/tools");
const { handleMessage } = require("../mcp/protocol");

// Static assets are loaded, hashed and validated once at startup; a broken
// asset fails the host rather than failing mid-game. The default is every
// adventure in adventures/manifest.json; ADVENTURE_ASSET_PATH narrows the
// deployment to a single asset (the original single-adventure contract).
const adventures = process.env.ADVENTURE_ASSET_PATH
  ? [loadAdventure(process.env.ADVENTURE_ASSET_PATH)]
  : loadAdventures(path.join(__dirname, "..", "..", "adventures", "manifest.json"));

const connectionString =
  process.env.ADVENTURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
if (!connectionString) {
  throw new Error(
    "No storage connection string: set ADVENTURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage."
  );
}
const store = new BlobRunStore(connectionString);

const tools = buildTools(adventures);

const SERVER_INFO = {
  name: "graph-adventures",
  version: "2.0.0",
  instructions: [
    `Runs gamebook-style graph adventures — this deployment hosts: ${adventures
      .map((a) => `${a.doc.graph.title} (adventure_id: ${a.id})`)
      .join("; ")}. Call list_adventures to see each one's genre, tone and premise, and let ` +
      "the player choose unless they already have. Loop: new_run with the chosen adventure_id " +
      "to get a run_id, then repeat: get_node to read the current node, player state and " +
      "available_routes, then walk with a chosen route_id and the revision get_node returned. " +
      "new_run also returns opening_context once — open the very first response with it " +
      "before describing the entry node.",

    "Every response should be rendered as immersive second-person narrative prose for the " +
      "player, not surfaced as data — in the voice and register of whichever adventure is " +
      "being played (each declares its genre and tone). The tool output is structured story " +
      "material for you to write a scene from — never paste raw JSON, field names, or " +
      "mechanical labels verbatim, and never read out ids, costs arrays or dice math as if " +
      "narrating a report.",

    "Narrating a node: open with node.read_aloud — the engine has already picked the right " +
      "text for you (a condition-matched variant if one applies, otherwise the correct choice " +
      "between first-visit and revisit phrasing per node.presentation), so don't second-guess " +
      "it or blend in text from an earlier visit. Present node.mandatory_exposition when it's " +
      "there, in your own words if read_aloud already implies it, rather than skipping it. " +
      "Weave in node.narrative's sensory_details, present_tension and local_history where they " +
      "deepen the scene, and node.rumour_delivery's speaker/text pairs when a node carries " +
      "gossip. hidden_truth (and a knowledge fact's meaning, see below) are for your " +
      "own understanding of subtext, not something to state outright unless the story has " +
      "actually revealed it. Then offer the available routes as in-world choices: use each " +
      "route's label for the concrete selectable action, but voice the offer through its hook " +
      "and stakes so the player feels the cost, risk or opportunity rather than reading it off " +
      "a list. When blocked_routes is present, weave those in too as visible-but-out-of-reach " +
      "opportunities: a 'blocked' entry's reason names exactly what's missing, so let the " +
      "player see the locked door and the shape of its key; a 'foreshadowed' entry's hint is " +
      "all that may be revealed — imply that more is possible here without saying what. Never " +
      "offer a blocked route as a takeable choice.",

    "Narrating a walk result: use route_resolution, when present, as the outcome's core " +
      "narration — it's written for exactly this moment (success or failure, whichever " +
      "happened). For skill/luck tests, resolution's rolls/total/target are for your own " +
      "reasoning about pacing and tone, not something to recite — narrate the outcome, not the " +
      "arithmetic. For combat, resolution.narrative (desire, fear, misconception, voice, " +
      "non_combat_leverage, aftermath) should drive how the encounter talks and fights, not " +
      "just how many stamina points changed. When effects_applied or arrival_effects_applied " +
      "includes an add_item with a narrative block, narrate the item's origin and " +
      "symbolic_role at the moment it's found, not just 'you gained X'; an add_knowledge entry " +
      "with player_text works the same way — deliver that revelation in scene, once, rather " +
      "than stating 'you now know X'. Never invent routes, items, facts or NPCs that aren't in " +
      "the tool output.",

    "If walk returns route_unavailable or a revision conflict, don't expose that as a system " +
      "error — re-fetch with get_node, find an in-world reason the attempt didn't land if one " +
      "fits the fiction, and re-offer the real choices from the corrected state.",

    "When status is completed, call get_node once more and narrate the ending in full. " +
      "get_log returns the complete step history if you need to reconstruct what's happened so " +
      "far in the run.",
  ].join("\n\n"),
};

// Anonymous, key-free and free of any secret in the response, so a wide-open
// Allow-Origin matches this endpoint's existing access model — it lets the
// browser-based adventure-walking website (web/) call it directly, cross-
// origin, the same way an LLM's MCP client already does server-to-server
// (where CORS never applied). Content-Type: application/json on the POST
// makes every browser call preflighted, hence the explicit OPTIONS handler.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// A single, plain HTTP endpoint that speaks MCP's JSON-RPC 2.0 protocol
// directly (initialize / tools/list / tools/call), with every tool
// consolidated under this one URL. Anonymous auth — no function key,
// no Azure Functions MCP-extension system route. This mirrors the
// Difference Engine / llm-library Functions apps' wiring pattern.
app.http("mcp", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "mcp",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return { status: 204, headers: CORS_HEADERS };
    }

    let message;
    try {
      message = await request.json();
    } catch {
      return {
        status: 400,
        headers: CORS_HEADERS,
        jsonBody: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      };
    }

    const engine = createEngine({ adventures, store, log: (m) => context.log(m) });
    const response = await handleMessage(message, {
      tools,
      engine,
      serverInfo: SERVER_INFO,
      log: (m) => context.log(m),
    });

    if (response === null) {
      return { status: 202, headers: CORS_HEADERS };
    }
    return { status: 200, headers: CORS_HEADERS, jsonBody: response };
  },
});

module.exports = { adventures, tools };
