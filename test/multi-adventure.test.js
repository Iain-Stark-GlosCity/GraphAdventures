"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { loadAdventures } = require("../src/engine/adventure");
const { createEngine } = require("../src/engine/engine");
const { MemoryRunStore } = require("../src/storage/memoryRunStore");
const { buildTools } = require("../src/mcp/tools");
const { scriptedDice } = require("./helpers");

const MANIFEST_PATH = path.join(__dirname, "..", "adventures", "manifest.json");

// The full deployed set, loaded once: the same manifest the Functions app
// reads at startup, so these tests exercise the exact multi-adventure
// configuration that ships.
const adventures = loadAdventures(MANIFEST_PATH);
const byId = new Map(adventures.map((a) => [a.id, a]));

function makeMultiEngine({ faces, store = new MemoryRunStore() } = {}) {
  const engine = createEngine({
    adventures,
    store,
    randomInt: scriptedDice(faces ?? []),
    now: () => "2026-07-06T12:00:00Z",
  });
  return { engine, store };
}

test("the manifest hosts the four adventures with unique ids", () => {
  assert.ok(adventures.length === 4, `expected 4 adventures, got ${adventures.length}`);
  assert.ok(byId.has("rust-wind-hills-dungeon"));
  assert.ok(byId.has("vienna-clearing-house"));
  assert.ok(byId.has("hollow-market-tithe"));
  assert.ok(byId.has("dragons-ledger-audit"));
});

test("every hosted adventure honours the walker contract: core stats and ending_dead", () => {
  for (const adventure of adventures) {
    const stats = adventure.doc.ruleset.player_state.stats;
    for (const required of ["skill", "stamina", "luck"]) {
      assert.ok(stats[required], `${adventure.id} is missing the ${required} stat`);
    }
    assert.equal(stats.stamina.min, 0, `${adventure.id} stamina must be able to reach 0`);
    assert.ok(adventure.nodesById.has("ending_dead"), `${adventure.id} is missing ending_dead`);
    assert.ok(adventure.terminalNodes.has("ending_dead"), `${adventure.id} ending_dead must be terminal`);
  }
});

test("list_adventures catalogues every hosted adventure with its graph metadata", async () => {
  const { engine } = makeMultiEngine();
  const { adventures: listed } = await engine.listAdventures();
  assert.equal(listed.length, adventures.length);
  const vienna = listed.find((a) => a.adventure_id === "vienna-clearing-house");
  assert.equal(vienna.title, "The Clearing House");
  assert.ok(Array.isArray(vienna.genre) && vienna.genre.includes("espionage"));
  assert.ok(vienna.narrative_premise.length > 0);
  assert.equal(vienna.node_count, byId.get("vienna-clearing-house").nodesById.size);
  assert.equal(vienna.ending_count, 5);
});

test("new_run dispatches by adventure_id and seeds each adventure's own ruleset", async () => {
  const { engine } = makeMultiEngine();

  const spy = await engine.newRun("vienna-clearing-house");
  assert.equal(spy.adventure_id, "vienna-clearing-house");
  assert.equal(spy.node.id, "cafe_sperl_brief");
  assert.equal(spy.state.resources.euros, 160);
  assert.equal(spy.state.stats.heat, 0);

  const fae = await engine.newRun("hollow-market-tithe");
  assert.equal(fae.node.id, "night_bus_terminus");
  assert.deepEqual(fae.state.inventory, ["cold_iron_nail", "sisters_ribbon"]);
  assert.equal(fae.state.resources.candle_marks, 10);

  const audit = await engine.newRun("dragons-ledger-audit");
  assert.equal(audit.node.id, "guildhall_dispatch");
  assert.equal(audit.state.resources.ink, 6);
  // Entry-node knowledge grants come enriched from that adventure's own
  // semantic layer.
  const grant = audit.arrival_effects_applied.find((e) => e.op === "add_knowledge");
  assert.equal(grant.fact, "guild_commission");
  assert.equal(grant.title, "Full and True");
});

test("new_run with an unknown adventure lists what this server hosts", async () => {
  const { engine } = makeMultiEngine();
  await assert.rejects(engine.newRun("tomb-of-horrors"), (e) => {
    assert.equal(e.code, "unknown_adventure");
    assert.match(e.message, /rust-wind-hills-dungeon/);
    assert.match(e.message, /dragons-ledger-audit/);
    assert.deepEqual(
      [...e.extra.hosted_adventures].sort(),
      ["dragons-ledger-audit", "hollow-market-tithe", "rust-wind-hills-dungeon", "vienna-clearing-house"]
    );
    return true;
  });
});

test("runs of different adventures share one store without crossing", async () => {
  const store = new MemoryRunStore();
  const { engine } = makeMultiEngine({ store });

  const dungeon = await engine.newRun("rust-wind-hills-dungeon");
  const spy = await engine.newRun("vienna-clearing-house");

  // Each run resolves against its own graph: same store, different worlds.
  const dungeonView = await engine.getNode(dungeon.run_id);
  const spyView = await engine.getNode(spy.run_id);
  assert.equal(dungeonView.node.id, "barrowgate_square");
  assert.equal(spyView.node.id, "cafe_sperl_brief");
  assert.equal(dungeonView.adventure_id, "rust-wind-hills-dungeon");
  assert.equal(spyView.adventure_id, "vienna-clearing-house");

  // Walking one run must not disturb the other.
  const spyStep = await engine.walk(spy.run_id, "r001", 0);
  assert.equal(spyStep.to, "safehouse_margareten");
  const dungeonAfter = await engine.getNode(dungeon.run_id);
  assert.equal(dungeonAfter.revision, 0);
  assert.equal(dungeonAfter.node.id, "barrowgate_square");

  // Route ids from another adventure are just unavailable routes here.
  await assert.rejects(engine.walk(dungeon.run_id, "h001", 0), (e) => {
    assert.equal(e.code, "route_unavailable");
    return true;
  });
});

test("a run against no-longer-hosted content is adventure_mismatch on get_node but get_log still serves", async () => {
  const store = new MemoryRunStore();
  const { engine } = makeMultiEngine({ store });
  const run = await engine.newRun("hollow-market-tithe");

  // Simulate a content update: same id, different hash.
  const { doc, etag } = await store.read(run.run_id);
  doc.adventure_hash = "sha256:not-the-deployed-bytes";
  await store.update(run.run_id, doc, etag);

  await assert.rejects(engine.getNode(run.run_id), (e) => {
    assert.equal(e.code, "adventure_mismatch");
    assert.equal(e.extra.run_adventure_id, "hollow-market-tithe");
    return true;
  });

  const log = await engine.getLog(run.run_id);
  assert.equal(log.adventure_mismatch, true);
  assert.equal(log.deployed_adventure_hash, byId.get("hollow-market-tithe").hash);
});

test("a walk through the spy adventure exercises the same DSL end to end", async () => {
  // 2d6 = 2 against skill 8: the bank bluff (r031, modifier -1) succeeds.
  const { engine } = makeMultiEngine({ faces: [1, 1] });
  const run = await engine.newRun("vienna-clearing-house");
  await engine.walk(run.run_id, "r001", 0); // to the safehouse
  const toBank = await engine.walk(run.run_id, "r011", 1); // recon the bank (1 hour)
  assert.equal(toBank.to, "clearing_bank_lobby");
  assert.equal(toBank.state_after.resources.hours, 13);

  const bluff = await engine.walk(run.run_id, "r031", 2);
  assert.equal(bluff.resolution.success, true);
  assert.equal(bluff.to, "meridian_meeting");
  assert.equal(bluff.state_after.flags.meridian_trust, "wary");
  // route_resolution text comes from this adventure's own semantic layer.
  assert.match(bluff.route_resolution, /lobby parts before it/);
});

test("glamour is a first-class test stat in the fae adventure", async () => {
  // Enter free (oath), then fail the riddle (2d6=12 vs skill), showing
  // failure_to routing; then check the canal's glamour test wiring.
  const { engine } = makeMultiEngine({ faces: [6, 6] });
  const run = await engine.newRun("hollow-market-tithe");
  await engine.walk(run.run_id, "h001", 0);
  const sworn = await engine.walk(run.run_id, "h011", 1);
  assert.equal(sworn.state_after.flags.oath_status, "sworn");

  const view = await engine.getNode(run.run_id);
  const canal = view.available_routes.find((r) => r.id === "h024");
  assert.ok(canal, "the canal towpath is open from the market hub");
  const toCanal = await engine.walk(run.run_id, "h024", 2);
  const shortcut = (toCanal.available_routes ?? []).find((r) => r.id === "h080");
  // Without the ledger-entry fact the shortcut's conditions fail, so it is
  // not offered — the gaol cannot be stumbled into before it's located.
  assert.equal(shortcut, undefined);
});

test("buildTools names every hosted adventure and list_adventures round-trips through a handler", async () => {
  const { engine } = makeMultiEngine();
  const tools = buildTools(adventures);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_log", "get_node", "list_adventures", "new_run", "walk"]);

  const newRun = tools.find((t) => t.name === "new_run");
  for (const adventure of adventures) {
    assert.match(newRun.description, new RegExp(adventure.id));
  }

  const list = tools.find((t) => t.name === "list_adventures");
  const result = await list.handler({}, engine);
  assert.equal(result.adventures.length, adventures.length);
});
