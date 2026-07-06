#!/usr/bin/env node
"use strict";

// Manual audit script: loads the static asset through the same loader the
// Functions app uses at startup and reports what it finds. Exits non-zero on
// validation failure. This is deliberately a script, not an MCP tool.

const path = require("node:path");
const { loadAdventure, loadAdventures } = require("../src/engine/adventure");

// With an argument: audit that one asset. Without: audit every adventure in
// adventures/manifest.json, same set the Functions app loads at startup.
let adventures;
try {
  adventures = process.argv[2]
    ? [loadAdventure(process.argv[2])]
    : loadAdventures(path.join(__dirname, "..", "adventures", "manifest.json"));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

for (const adventure of adventures) {
  console.log(`OK: ${adventure.id} v${adventure.version}`);
  console.log(`  hash:       ${adventure.hash}`);
  console.log(`  nodes:      ${adventure.nodesById.size}`);
  console.log(`  routes:     ${adventure.routesById.size}`);
  console.log(`  encounters: ${adventure.encountersById.size}`);
  console.log(`  entry:      ${adventure.entryNode}`);
  console.log(`  terminals:  ${[...adventure.terminalNodes].join(", ")}`);
}
