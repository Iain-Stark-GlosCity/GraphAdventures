#!/usr/bin/env node
"use strict";

// Randomised playthrough simulation: plays many runs of the real graph
// through the real engine (in-memory store, real crypto dice), picking a
// uniformly random available route each step. Complements
// check-reachability.js's structural BFS (which ignores conditions
// entirely) with a probabilistic signal for state-dependent problems —
// routes that are only reachable through a specific flag/item combination
// a random walker is unlikely to assemble, or genuine soft locks.
//
// This does not hard-fail on soft locks or unreached endings by default:
// vault_antechamber and gate_of_tithes are known, disclosed content soft
// locks (see the spec's "known content bugs to fix in the JSON, not the
// runtime" section) that a content update could leave in place indefinitely
// without that being a regression. Failing CI on their mere presence would
// make every content-only PR red until someone rewrites unrelated routes.
// The script instead reports stuck nodes and ending coverage every run so
// the trend is visible, and only exits non-zero if the engine itself
// throws — an actual bug, not a content nuance.
//
// Usage:
//   node scripts/simulate-playthroughs.js [assetPath] [runCount]

const path = require("node:path");
const { loadAdventure } = require("../src/engine/adventure");
const { createEngine } = require("../src/engine/engine");
const { MemoryRunStore } = require("../src/storage/memoryRunStore");

const assetPath =
  process.argv[2] ??
  path.join(__dirname, "..", "rust_wind_hills_adventure_knowledge_graph.json");
const runCount = Number(process.argv[3] ?? 300);
const STEP_BUDGET = 400;

const adventure = loadAdventure(assetPath);

async function playOne() {
  const engine = createEngine({ adventure, store: new MemoryRunStore() });
  const { run_id } = await engine.newRun(adventure.id);
  for (let steps = 0; steps < STEP_BUDGET; steps++) {
    const view = await engine.getNode(run_id);
    if (view.status === "completed") return { outcome: view.node.id, steps };
    if (view.available_routes.length === 0) return { outcome: `STUCK@${view.node.id}`, steps };
    const route = view.available_routes[Math.floor(Math.random() * view.available_routes.length)];
    const step = await engine.walk(run_id, route.id, view.revision);
    if (step.status_after === "completed") return { outcome: step.to, steps: steps + 1 };
  }
  return { outcome: "STEP_BUDGET_EXCEEDED", steps: STEP_BUDGET };
}

(async () => {
  const outcomes = new Map();
  let totalSteps = 0;
  for (let i = 0; i < runCount; i++) {
    const { outcome, steps } = await playOne();
    totalSteps += steps;
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }

  console.log(`Random playthrough simulation: ${adventure.id} v${adventure.version}`);
  console.log(`  ${runCount} runs, ${totalSteps} total walk steps`);
  console.log();

  const terminals = [...adventure.terminalNodes].sort();
  const reachedEndings = terminals.filter((t) => outcomes.has(t));
  const unreachedEndings = terminals.filter((t) => !outcomes.has(t));
  console.log(`  endings reached: ${reachedEndings.length}/${terminals.length}`);
  if (unreachedEndings.length > 0) {
    console.log(`    not reached in this sample (may just need more runs or specific state): ${unreachedEndings.join(", ")}`);
  }

  const stuck = [...outcomes.keys()].filter((k) => k.startsWith("STUCK@"));
  if (stuck.length > 0) {
    console.log(`  soft locks encountered (0 available routes, not yet terminal):`);
    for (const s of stuck) console.log(`    ${s}: ${outcomes.get(s)} run(s)`);
  } else {
    console.log("  no soft locks encountered in this sample.");
  }

  console.log();
  for (const [outcome, count] of [...outcomes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome}: ${count}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
