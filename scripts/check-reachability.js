#!/usr/bin/env node
"use strict";

// Deterministic structural check, independent of the randomised playthrough
// simulation (scripts/simulate-playthroughs.js): a BFS over the graph's
// edges alone, ignoring every condition/cost/test — "can a route to this
// node exist at all," not "can the average random walker reach it." Two
// failure modes:
//
//   - a node with no path to it at all from graph.entry_node, following
//     both route.to and (where a route has a test) test.failure_to;
//   - a non-terminal node with zero outgoing routes: a structural dead end
//     no state could ever escape, regardless of conditions.
//
// This does not (and cannot, without a constraint solver) prove every
// state-dependent path is satisfiable — a node can be structurally
// reachable and still be an unreachable-in-practice soft lock if every
// route into it needs a flag/item combination nothing ever grants. That's
// what simulate-playthroughs.js probes for instead.

const path = require("node:path");
const { loadAdventure, loadAdventures } = require("../src/engine/adventure");

// With an argument: check that one asset. Without: check every adventure in
// adventures/manifest.json, same set the Functions app loads at startup.
const adventures = process.argv[2]
  ? [loadAdventure(process.argv[2])]
  : loadAdventures(path.join(__dirname, "..", "adventures", "manifest.json"));

function checkAdventure(adventure) {
  const edges = new Map();
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  for (const route of adventure.doc.routes) {
    addEdge(route.from, route.to);
    if (route.test?.failure_to) addEdge(route.from, route.test.failure_to);
  }

  const reached = new Set([adventure.entryNode]);
  const queue = [adventure.entryNode];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    for (const next of edges.get(nodeId) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  const allNodeIds = [...adventure.nodesById.keys()];
  const unreachable = allNodeIds.filter((id) => !reached.has(id));
  const deadEnds = allNodeIds.filter(
    (id) => !adventure.terminalNodes.has(id) && (edges.get(id) ?? new Set()).size === 0
  );

  console.log(`Structural reachability: ${adventure.id} v${adventure.version}`);
  console.log(`  nodes: ${allNodeIds.length}, reachable from entry: ${reached.size}`);

  let failed = false;
  if (unreachable.length > 0) {
    failed = true;
    console.error(`  UNREACHABLE from ${adventure.entryNode}: ${unreachable.join(", ")}`);
  }
  if (deadEnds.length > 0) {
    failed = true;
    console.error(`  NON-TERMINAL DEAD ENDS (no outgoing routes at all): ${deadEnds.join(", ")}`);
  }
  if (!failed) {
    console.log("  OK: every node is structurally reachable and has an exit or is terminal.");
  }
  return failed;
}

const anyFailed = adventures.map(checkAdventure).some(Boolean);
process.exit(anyFailed ? 1 : 0);
