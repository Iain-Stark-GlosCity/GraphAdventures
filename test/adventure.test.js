"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { adventure, ASSET_PATH } = require("./helpers");
const { initialState, validateAdventure } = require("../src/engine/adventure");

test("asset loads, indexes and passes validation", () => {
  assert.equal(adventure.id, "rust-wind-hills-dungeon");
  assert.equal(adventure.version, adventure.doc.schema.version);
  assert.equal(adventure.nodesById.size, adventure.doc.nodes.length);
  assert.equal(adventure.routesById.size, adventure.doc.routes.length);
  assert.equal(validateAdventure(adventure).length, 0);
});

test("hash is sha256 of the exact file bytes", () => {
  const expected = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(ASSET_PATH)).digest("hex")}`;
  assert.equal(adventure.hash, expected);
});

test("initial state is seeded from the ruleset's initial values", () => {
  const state = initialState(adventure);
  assert.equal(state.current_node, adventure.entryNode);
  assert.deepEqual(state.stats, { skill: 8, stamina: 16, luck: 8, reputation: 0 });
  assert.deepEqual(state.resources, { gold: 15, provisions: 3, torch_turns: 12 });
  assert.deepEqual(state.inventory, []);
  assert.deepEqual(state.conditions, []);
  assert.deepEqual(state.knowledge, []);
  assert.deepEqual(state.consumed_routes, []);
  assert.equal(state.flags.permit_status, "none");
  assert.equal(state.flags.registrar_alerted, false);
});

test("validation rejects broken references", () => {
  const broken = structuredClone(adventure);
  broken.doc = structuredClone(adventure.doc);
  broken.doc.routes = [
    ...broken.doc.routes,
    { id: "rBAD", from: "nowhere", to: "barrowgate_square", label: "x", kind: "path" },
  ];
  broken.routesById = new Map(broken.doc.routes.map((r) => [r.id, r]));
  const errors = validateAdventure(broken);
  assert.ok(errors.some((e) => e.includes("rBAD") && e.includes("nowhere")));
});

test("validation rejects a read_aloud_variants condition referencing an unknown flag", () => {
  const broken = structuredClone(adventure);
  broken.doc = structuredClone(adventure.doc);
  const node = broken.doc.nodes.find((n) => n.id === broken.doc.graph.entry_node);
  node.read_aloud_variants = [
    {
      conditions: [{ op: "flag_is", flag: "totally_made_up_flag", value: true }],
      priority: 1,
      text: "unreachable variant with a typo'd condition",
    },
  ];
  const errors = validateAdventure(broken);
  assert.ok(errors.some((e) => e.includes("read_aloud_variants") && e.includes("totally_made_up_flag")));
});
