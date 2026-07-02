"use strict";

const path = require("node:path");
const { app } = require("@azure/functions");

const { loadAdventure } = require("../engine/adventure");
const { createEngine } = require("../engine/engine");
const { EngineError } = require("../engine/errors");
const { BlobRunStore } = require("../storage/blobRunStore");

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

/**
 * Registers an MCP tool with the Functions host. Newer @azure/functions
 * releases expose app.mcpTool; older ones need the generic mcpToolTrigger
 * with stringified toolProperties. Support both so the app tracks the same
 * func-* wiring pattern as the other MCP Functions apps.
 *
 * handler receives (args, engine) and returns the result object; EngineError
 * shapes are returned to the caller as-is, anything else becomes an opaque
 * internal_error.
 */
function registerTool(functionName, { toolName, description, properties, handler }) {
  const invoke = async (toolArguments, context) => {
    const args =
      (toolArguments && typeof toolArguments === "object" ? toolArguments : null) ??
      context.triggerMetadata?.mcptoolargs ??
      {};
    const engine = createEngine({ adventure, store, log: (msg) => context.log(msg) });
    try {
      return JSON.stringify(await handler(args, engine));
    } catch (e) {
      if (e instanceof EngineError) {
        context.log(`${toolName}: ${e.code} — ${e.message}`);
        return JSON.stringify(e.toResponse());
      }
      context.error(`${toolName} failed: ${e.stack ?? e}`);
      return JSON.stringify({ code: "internal_error", message: "An internal error occurred." });
    }
  };

  if (typeof app.mcpTool === "function") {
    app.mcpTool(functionName, {
      toolName,
      description,
      toolProperties: properties,
      handler: invoke,
    });
  } else {
    app.generic(functionName, {
      trigger: {
        type: "mcpToolTrigger",
        toolName,
        description,
        toolProperties: JSON.stringify(properties),
      },
      handler: (context) => invoke(undefined, context),
    });
  }
}

registerTool("newRun", {
  toolName: "new_run",
  description:
    "Start a new run of the Rust Wind Hills adventure. Returns the run_id, the entry node and the freshly seeded player state.",
  properties: [
    {
      propertyName: "adventure_id",
      propertyType: "string",
      description: `Adventure to run; this server hosts "${adventure.id}".`,
      required: true,
    },
    {
      propertyName: "label",
      propertyType: "string",
      description: "Optional caller-supplied label for the run.",
      required: false,
    },
  ],
  handler: (args, engine) => engine.newRun(args.adventure_id, args.label ?? null),
});

registerTool("getNode", {
  toolName: "get_node",
  description:
    "Read-only view of a run: current node, player state and the routes available right now. Works on completed runs too (with no routes) so the ending can be narrated.",
  properties: [
    {
      propertyName: "run_id",
      propertyType: "string",
      description: "The run to inspect.",
      required: true,
    },
  ],
  handler: (args, engine) => engine.getNode(args.run_id),
});

registerTool("walk", {
  toolName: "walk",
  description:
    "Take a route from the current node. Requires the run's current revision (from get_node); costs are spent, any test is rolled, effects applied, and the committed step is returned.",
  properties: [
    {
      propertyName: "run_id",
      propertyType: "string",
      description: "The run to advance.",
      required: true,
    },
    {
      propertyName: "route_id",
      propertyType: "string",
      description: "The route to take, chosen from get_node's available_routes.",
      required: true,
    },
    {
      propertyName: "expected_revision",
      propertyType: "number",
      description: "The revision the caller believes the run is at; mismatches are rejected.",
      required: true,
    },
  ],
  handler: (args, engine) => engine.walk(args.run_id, args.route_id, args.expected_revision),
});

registerTool("getLog", {
  toolName: "get_log",
  description:
    "Full step log for a run. Still served if the deployed adventure content has changed, flagged with adventure_mismatch.",
  properties: [
    {
      propertyName: "run_id",
      propertyType: "string",
      description: "The run whose log to fetch.",
      required: true,
    },
  ],
  handler: (args, engine) => engine.getLog(args.run_id),
});
