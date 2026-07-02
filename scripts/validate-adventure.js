#!/usr/bin/env node
"use strict";

// Manual audit script: loads the static asset through the same loader the
// Functions app uses at startup and reports what it finds. Exits non-zero on
// validation failure. This is deliberately a script, not an MCP tool.

const path = require("node:path");
const { loadAdventure } = require("../src/engine/adventure");

const assetPath =
  process.argv[2] ??
  path.join(__dirname, "..", "rust_wind_hills_adventure_knowledge_graph.json");

try {
  const adventure = loadAdventure(assetPath);
  console.log(`OK: ${adventure.id} v${adventure.version}`);
  console.log(`  hash:       ${adventure.hash}`);
  console.log(`  nodes:      ${adventure.nodesById.size}`);
  console.log(`  routes:     ${adventure.routesById.size}`);
  console.log(`  encounters: ${adventure.encountersById.size}`);
  console.log(`  entry:      ${adventure.entryNode}`);
  console.log(`  terminals:  ${[...adventure.terminalNodes].join(", ")}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
