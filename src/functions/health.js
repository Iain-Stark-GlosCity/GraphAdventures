"use strict";

const path = require("node:path");
const { app } = require("@azure/functions");
const { loadAdventure } = require("../engine/adventure");

// Loaded independently of mcp.js so this endpoint reports its own honest
// view of readiness rather than assuming mcp.js's module-scope work
// succeeded. In practice, if the adventure asset or storage configuration
// is broken, mcp.js throws at require time and the whole worker fails to
// start — this endpoint being reachable at all already implies that
// succeeded.
let adventureInfo = null;
let loadError = null;
try {
  const assetPath =
    process.env.ADVENTURE_ASSET_PATH ??
    path.join(__dirname, "..", "..", "rust_wind_hills_adventure_knowledge_graph.json");
  const adventure = loadAdventure(assetPath);
  adventureInfo = {
    id: adventure.id,
    version: adventure.version,
    hash: adventure.hash,
    node_count: adventure.nodesById.size,
    route_count: adventure.routesById.size,
  };
} catch (e) {
  loadError = e.message;
}

const storageConfigured = Boolean(
  process.env.ADVENTURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage
);

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const ready = !loadError && storageConfigured;
    return {
      status: ready ? 200 : 503,
      jsonBody: {
        ok: ready,
        data: {
          configuration: {
            ready,
            adventure: adventureInfo,
            error: loadError ?? (storageConfigured ? null : "no storage connection string configured"),
          },
        },
      },
    };
  },
});
