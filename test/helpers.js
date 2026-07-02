"use strict";

const path = require("node:path");
const { loadAdventure } = require("../src/engine/adventure");
const { createEngine } = require("../src/engine/engine");
const { MemoryRunStore } = require("../src/storage/memoryRunStore");

const ASSET_PATH = path.join(__dirname, "..", "rust_wind_hills_adventure_knowledge_graph.json");

// Load once; the asset is static.
const adventure = loadAdventure(ASSET_PATH);

/**
 * randomInt(sides) replacement fed from a queue of desired die faces
 * (1-based, as a player would say them). Runs of tests that roll more dice
 * than scripted fall back to always rolling 1.
 */
function scriptedDice(faces = []) {
  const queue = [...faces];
  return (sides) => {
    const face = queue.length > 0 ? queue.shift() : 1;
    if (face < 1 || face > sides) throw new Error(`scripted face ${face} out of range for d${sides}`);
    return face - 1;
  };
}

function makeEngine({ faces, store = new MemoryRunStore(), now } = {}) {
  const engine = createEngine({
    adventure,
    store,
    randomInt: scriptedDice(faces ?? []),
    now: now ?? (() => "2026-07-02T17:00:00Z"),
  });
  return { engine, store, adventure };
}

/** Finds a route by predicate; throws if the graph no longer contains one. */
function findRoute(pred) {
  const route = adventure.doc.routes.find(pred);
  if (!route) throw new Error("no route in the asset matches the test's predicate");
  return route;
}

module.exports = { adventure, scriptedDice, makeEngine, findRoute, ASSET_PATH };
