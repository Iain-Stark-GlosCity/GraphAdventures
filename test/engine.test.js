"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeEngine } = require("./helpers");
const { EngineError, StoreConflictError } = require("../src/engine/errors");
const { MemoryRunStore } = require("../src/storage/memoryRunStore");

const ADVENTURE_ID = "rust-wind-hills-dungeon";

// Tests place the run at a specific node/state by editing the stored doc
// directly instead of playing the graph there.
function stored(store, runId) {
  return store.runs.get(runId).doc;
}

async function rejects(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof EngineError, `expected EngineError, got ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected EngineError ${code}, but the call succeeded`);
}

test("new_run seeds state, writes the run doc, and rejects unknown adventures", async () => {
  const { engine, store, adventure } = makeEngine();
  const run = await engine.newRun(ADVENTURE_ID, "first attempt");
  assert.match(run.run_id, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(run.label, "first attempt");
  assert.equal(run.revision, 0);
  assert.equal(run.status, "active");
  assert.equal(run.node.id, "barrowgate_square");
  assert.deepEqual(run.arrival_effects_applied, []);

  const doc = stored(store, run.run_id);
  assert.equal(doc.schema_version, "1.0");
  assert.equal(doc.adventure_hash, adventure.hash);
  assert.equal(doc.state.current_node, "barrowgate_square");
  assert.deepEqual(doc.state.stats, { skill: 8, stamina: 16, luck: 8, reputation: 0 });
  assert.deepEqual(doc.log, []);

  const other = await engine.newRun(ADVENTURE_ID);
  assert.equal(other.label, null);
  assert.notEqual(other.run_id, run.run_id);

  await rejects(engine.newRun("some-other-dungeon"), "unknown_adventure");
});

test("an explicit read_aloud wins over narrative.arrival_text", async () => {
  const { engine, adventure } = makeEngine();
  // barrowgate_square (entry node) has both fields, deliberately different —
  // the explicit one must win. True as of content revision 0.2.1, where
  // every node has an explicit read_aloud; this pins that precedence.
  const entryNode = adventure.doc.nodes.find((n) => n.id === "barrowgate_square");
  assert.ok(entryNode.read_aloud);
  assert.notEqual(entryNode.read_aloud, entryNode.narrative.arrival_text);
  const { node } = await engine.newRun(ADVENTURE_ID);
  assert.equal(node.read_aloud, entryNode.read_aloud);
});

test("visit_count/presentation track arrivals, and the engine picks read_aloud vs read_aloud_revisit itself", async () => {
  const { engine, adventure } = makeEngine();
  const entryNode = adventure.doc.nodes.find((n) => n.id === "barrowgate_square");
  assert.ok(entryNode.read_aloud_revisit);
  assert.notEqual(entryNode.read_aloud_revisit, entryNode.read_aloud);

  const run = await engine.newRun(ADVENTURE_ID);
  assert.equal(run.node.visit_count, 1);
  assert.equal(run.node.presentation, "first_visit");
  assert.equal(run.node.read_aloud, entryNode.read_aloud);
  assert.ok(!("read_aloud_revisit" in run.node)); // not exposed raw any more

  // get_node on the same, unchanged position reports the same first visit
  // without incrementing it (read-only).
  const view1 = await engine.getNode(run.run_id);
  assert.equal(view1.node.visit_count, 1);
  assert.equal(view1.node.presentation, "first_visit");

  // Leave and come back: bent_nail_inn -> barrowgate_square (r001, r008).
  await engine.walk(run.run_id, "r001", 0);
  const back = await engine.walk(run.run_id, "r008", 1);
  assert.equal(back.node.id, "barrowgate_square");
  assert.equal(back.node.visit_count, 2);
  assert.equal(back.node.presentation, "revisit");
  assert.equal(back.node.read_aloud, entryNode.read_aloud_revisit);

  // get_node reflects the recorded revisit too, still without mutating it.
  const view2 = await engine.getNode(run.run_id);
  assert.equal(view2.node.visit_count, 2);
  assert.equal(view2.node.presentation, "revisit");
});

test("visited_nodes is engine bookkeeping, hidden from the public state projection", async () => {
  const { engine } = makeEngine();
  const run = await engine.newRun(ADVENTURE_ID);
  assert.ok(!("visited_nodes" in run.state));
  assert.ok(!("current_node" in run.state));
  assert.ok(!("consumed_routes" in run.state));
});

test("a run persisted before visit tracking existed doesn't crash walk or get_node", async () => {
  const { engine, store } = makeEngine();
  const run = await engine.newRun(ADVENTURE_ID);
  delete stored(store, run.run_id).state.visited_nodes; // simulate a pre-existing run doc

  const view = await engine.getNode(run.run_id);
  assert.equal(view.node.visit_count, 1); // defaults to first visit rather than throwing

  const step = await engine.walk(run.run_id, "r001", 0);
  assert.equal(step.node.visit_count, 1); // self-heals: records this as the first visit there
});

test("read_aloud falls back to narrative.arrival_text when a node has none of its own", async () => {
  // Content currently gives every node an explicit read_aloud, so this
  // exercises the fallback directly against a synthetic node rather than
  // depending on the asset happening to have a gap — the guarantee is
  // about the engine's behaviour, not today's content.
  const { engine, adventure } = makeEngine();
  const nodeId = "bent_nail_inn";
  const original = adventure.nodesById.get(nodeId);
  const synthetic = { ...original, narrative: { ...original.narrative, arrival_text: "SYNTHETIC ARRIVAL" } };
  delete synthetic.read_aloud;
  adventure.nodesById.set(nodeId, synthetic);
  try {
    const { run_id } = await engine.newRun(ADVENTURE_ID);
    const step = await engine.walk(run_id, "r001", 0);
    assert.equal(step.node.id, nodeId);
    assert.equal(step.node.read_aloud, "SYNTHETIC ARRIVAL");
  } finally {
    adventure.nodesById.set(nodeId, original);
  }
});

test("get_node/walk expose the rest of node.narrative, minus the arrival_text folded into read_aloud", async () => {
  const { engine, adventure } = makeEngine();
  const innNode = adventure.doc.nodes.find((n) => n.id === "bent_nail_inn");
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  const step = await engine.walk(run_id, "r001", 0);
  assert.ok(!("arrival_text" in step.node.narrative));
  assert.equal(step.node.narrative.local_history, innNode.narrative.local_history);
  assert.equal(step.node.narrative.hidden_truth, innNode.narrative.hidden_truth);
  assert.deepEqual(step.node.narrative.sensory_details, innNode.narrative.sensory_details);
  assert.deepEqual(step.node.narrative.semantic_refs, innNode.narrative.semantic_refs);

  const view = await engine.getNode(run_id);
  assert.deepEqual(view.node.narrative, step.node.narrative);
});

test("routes expose stakes/hook, and narrative.content_role is dropped as schema documentation, not content", async () => {
  const { engine, adventure } = makeEngine();
  const r001 = adventure.doc.routes.find((r) => r.id === "r001");
  assert.ok(r001.stakes);
  assert.ok(r001.hook);
  assert.ok(r001.narrative.content_role);

  const view = await engine.getNode(await engine.newRun(ADVENTURE_ID).then((r) => r.run_id));
  const publicR001 = view.available_routes.find((r) => r.id === "r001");
  assert.equal(publicR001.stakes, r001.stakes);
  assert.equal(publicR001.hook, r001.hook);
  assert.ok(!("content_role" in publicR001.narrative));
  assert.equal(publicR001.narrative.player_intent, r001.narrative.player_intent);
});

test("get_node filters routes on visibility, legality, affordability and consumption", async () => {
  const { engine, store } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  let view = await engine.getNode(run_id);
  let ids = view.available_routes.map((r) => r.id);
  // r006 is a secret route hidden behind knows(rumour_red_quill).
  assert.deepEqual(ids, ["r001", "r002", "r003", "r004", "r005", "r007"]);
  // Public route objects never leak failure or visibility details.
  for (const r of view.available_routes) {
    assert.deepEqual(Object.keys(r).sort(), ["costs", "hook", "id", "label", "narrative", "stakes", "test"]);
    if (r.test) {
      assert.ok(!("failure_to" in r.test));
      assert.ok(!("failure_effects" in r.test));
    }
  }
  // Route narrative is passed through (player_intent, dramatic_role, etc.).
  const r001 = view.available_routes.find((r) => r.id === "r001");
  assert.equal(typeof r001.narrative.player_intent, "string");
  // State projection matches the spec sample: no current_node/consumed_routes.
  assert.deepEqual(
    Object.keys(view.state).sort(),
    ["conditions", "flags", "inventory", "knowledge", "resources", "stats"]
  );

  // Learning the rumour reveals r006.
  stored(store, run_id).state.knowledge.push("rumour_red_quill");
  view = await engine.getNode(run_id);
  assert.ok(view.available_routes.some((r) => r.id === "r006"));

  // An unaffordable route disappears: r015 costs 6 gold.
  const doc = stored(store, run_id);
  doc.state.current_node = "licensing_hall";
  doc.state.resources.gold = 5;
  view = await engine.getNode(run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "r015"));
  doc.state.resources.gold = 6;
  view = await engine.getNode(run_id);
  assert.ok(view.available_routes.some((r) => r.id === "r015"));
});

test("walk without a test is an automatic success; arrival knowledge_grants convert to records", async () => {
  const { engine } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  const step = await engine.walk(run_id, "r001", 0);
  assert.equal(step.from, "barrowgate_square");
  assert.equal(step.to, "bent_nail_inn");
  assert.equal(step.revision_before, 0);
  assert.equal(step.revision_after, 1);
  assert.equal(step.status_after, "active");
  assert.equal(step.resolution, null);
  assert.deepEqual(step.arrival_effects_applied, [
    { op: "add_knowledge", fact: "rumour_crown_ember_salt", source: "bent_nail_inn" },
    { op: "add_knowledge", fact: "rumour_ninth_lock", source: "bent_nail_inn" },
  ]);
  assert.deepEqual(step.state_after.knowledge, ["rumour_crown_ember_salt", "rumour_ninth_lock"]);

  // walk's response is the logged step plus node/available_routes computed
  // fresh (not persisted) — everything logged is still identical to what
  // was returned, just without those two extra convenience fields.
  const { node, available_routes, ...loggedShape } = step;
  const log = await engine.getLog(run_id);
  assert.deepEqual(log.log, [loggedShape]);
  assert.equal(log.revision, 1);
  assert.equal(node.id, "bent_nail_inn");
  assert.ok(!("node" in log.log[0]));
  assert.ok(!("available_routes" in log.log[0]));

  // Back to the square: r008's route effects add three facts, one of which
  // (rumour_ninth_lock) is already known — the add is an idempotent no-op.
  const back = await engine.walk(run_id, "r008", 1);
  assert.deepEqual(back.state_after.knowledge, [
    "rumour_crown_ember_salt",
    "rumour_ninth_lock",
    "rumour_red_quill",
    "rumour_dust_saint",
  ]);
  // Re-arriving at the inn grants nothing new either.
  const again = await engine.walk(run_id, "r001", 2);
  assert.deepEqual(again.arrival_effects_applied, []);
});

test("walk enforces expected_revision and coerces string input", async () => {
  const { engine, store } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  const err = await rejects(engine.walk(run_id, "r001", 3), "revision_conflict");
  assert.equal(err.extra.current_revision, 0);
  assert.deepEqual(stored(store, run_id).log, []);

  const step = await engine.walk(run_id, "r001", "0");
  assert.equal(step.revision_after, 1);
});

test("steps 5-9 all collapse into the same generic route_unavailable", async () => {
  const { engine, store } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  const expectUnavailable = async (routeId) => {
    const err = await rejects(engine.walk(run_id, routeId, 0), "route_unavailable");
    assert.equal(err.message, "That route is not available from the current position.");
    assert.deepEqual(err.extra, {});
  };

  await expectUnavailable("r999"); // unknown id
  await expectUnavailable("r015"); // exists, but starts at licensing_hall
  await expectUnavailable("r006"); // starts here, but hidden without the rumour

  // Unaffordable: r015 from licensing_hall with too little gold.
  const doc = stored(store, run_id);
  doc.state.current_node = "licensing_hall";
  doc.state.resources.gold = 5;
  await expectUnavailable("r015");
  // Nothing was committed by any of these.
  assert.equal(stored(store, run_id).revision, 0);
  assert.deepEqual(stored(store, run_id).log, []);
});

test("costs are deducted and recorded as negative amounts; effects apply", async () => {
  const { engine, store, adventure } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "licensing_hall";

  const step = await engine.walk(run_id, "r015", 0);
  assert.deepEqual(step.costs_applied, [{ resource: "gold", amount: -6 }]);
  assert.equal(step.state_after.resources.gold, 9);
  assert.ok(step.state_after.inventory.includes("standard_delver_licence"));
  assert.equal(step.state_after.flags.permit_status, "licensed");
  assert.equal(step.state_after.stats.reputation, 1);

  // add_item is enriched with the item's name/description/narrative_semantics
  // on the live response; the other effect records are untouched.
  const licence = adventure.doc.items.find((i) => i.id === "standard_delver_licence");
  assert.deepEqual(step.effects_applied, [
    {
      op: "add_item",
      item: "standard_delver_licence",
      name: licence.name,
      description: licence.description,
      narrative: licence.narrative_semantics,
    },
    { op: "set_flag", flag: "permit_status", value: "licensed" },
    { op: "modify_stat", stat: "reputation", amount: 1 },
  ]);

  // But what's actually persisted stays lean — get_log never sees the
  // enrichment, only the { op, item } shape the spec documents.
  const log = await engine.getLog(run_id);
  assert.deepEqual(log.log[0].effects_applied[0], { op: "add_item", item: "standard_delver_licence" });
});

test("walk's node/available_routes match a follow-up get_node, with no extra storage read", async () => {
  const { engine } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  const step = await engine.walk(run_id, "r001", 0); // barrowgate_square -> bent_nail_inn
  const view = await engine.getNode(run_id);

  assert.deepEqual(step.node, view.node);
  assert.deepEqual(step.available_routes, view.available_routes);
  assert.ok(step.available_routes.some((r) => r.id === "r008")); // bent_nail_inn -> barrowgate_square
});

test("walk's node/available_routes reflect the terminal node on death, empty routes", async () => {
  const faces = Array.from({ length: 8 }, () => [1, 1, 6, 6]).flat();
  const { engine, store } = makeEngine({ faces });
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "goblin_toll_path";

  const step = await engine.walk(run_id, "r028", 0);
  assert.equal(step.status_after, "completed");
  assert.equal(step.node.id, "ending_dead");
  assert.deepEqual(step.available_routes, []);
});

test("skill test: success takes route.to and route.effects", async () => {
  // r016 (licensing_hall): 2d6 <= skill 8 + 0. Faces 1+1 = 2 -> success.
  const { engine, store } = makeEngine({ faces: [1, 1] });
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "licensing_hall";

  const step = await engine.walk(run_id, "r016", 0);
  assert.deepEqual(step.resolution, {
    type: "skill",
    rolls: [1, 1],
    total: 2,
    target: 8,
    success: true,
  });
  assert.equal(step.to, "forgery_cellar");
  assert.deepEqual(step.effects_applied, [{ op: "add_knowledge", fact: "rumour_red_quill" }]);
});

test("skill test: failure takes failure_to and failure_effects; costs stay spent", async () => {
  // Faces 6+6 = 12 > 8 -> failure. r016 has no costs, so also check the
  // failure branch's reputation penalty.
  const { engine, store } = makeEngine({ faces: [6, 6] });
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "licensing_hall";

  const step = await engine.walk(run_id, "r016", 0);
  assert.equal(step.resolution.success, false);
  assert.equal(step.to, "barrowgate_square");
  assert.deepEqual(step.effects_applied, [{ op: "modify_stat", stat: "reputation", amount: -1 }]);
  assert.equal(step.state_after.stats.reputation, -1);
});

test("luck tests target luck+modifier and always cost 1 luck; one_time routes consume", async () => {
  // r065 (mirror_maze, one_time): luck test, modifier -1 -> target 7.
  const { engine, store } = makeEngine({ faces: [2, 3] }); // total 5 <= 7 -> success
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "mirror_maze";

  const step = await engine.walk(run_id, "r065", 0);
  assert.deepEqual(step.resolution, {
    type: "luck",
    rolls: [2, 3],
    total: 5,
    target: 7,
    success: true,
  });
  assert.equal(step.state_after.stats.luck, 7); // decremented after the check
  assert.ok(step.state_after.inventory.includes("moon_key"));
  assert.deepEqual(step.state_after.consumed_routes, ["r065"]);

  // Consumed: a second attempt is generically unavailable, and get_node
  // no longer offers it.
  await rejects(engine.walk(run_id, "r065", 1), "route_unavailable");
  const view = await engine.getNode(run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "r065"));
});

test("luck decrements on failure too, and one_time consumes even on failure", async () => {
  const { engine, store } = makeEngine({ faces: [6, 6] }); // 12 > 7 -> failure
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "mirror_maze";

  const step = await engine.walk(run_id, "r065", 0);
  assert.equal(step.resolution.success, false);
  assert.equal(step.state_after.stats.luck, 7);
  assert.equal(step.state_after.stats.stamina, 14); // failure_effects -2
  assert.deepEqual(step.state_after.consumed_routes, ["r065"]);
});

test("r063 is typed skill but tests luck: stat is read, never inferred from type", async () => {
  const { engine, store } = makeEngine({ faces: [4, 5] }); // 9 > luck 8 -> failure
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "mirror_maze";

  const step = await engine.walk(run_id, "r063", 0);
  assert.equal(step.resolution.type, "skill");
  assert.equal(step.resolution.target, 8); // luck, not skill+... (skill would also be 8; check decrement)
  assert.equal(step.resolution.success, false);
  assert.equal(step.state_after.stats.luck, 7); // luck spent because test.stat is luck
  assert.equal(step.state_after.stats.skill, 8);
  assert.equal(step.to, "mirror_maze");
  assert.equal(step.state_after.resources.torch_turns, 10);
});

test("a combat route names its encounter before it's engaged", async () => {
  const { engine, store, adventure } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "goblin_toll_path";

  const view = await engine.getNode(run_id);
  const r028 = view.available_routes.find((r) => r.id === "r028");
  const encounter = adventure.doc.encounters.find((e) => e.id === "goblin_toll_collectors");
  assert.equal(r028.test.encounter_name, encounter.name);
  assert.equal(r028.test.encounter_kind, encounter.kind);
  assert.ok(!("skill" in r028.test) && !("stamina" in r028.test)); // no combat-math leak
});

test("combat: rounds run until a side drops; victory takes route.to", async () => {
  // r028 vs goblin_toll_collectors (skill 6, stamina 7). Player rolls 6+6,
  // enemy 1+1 every round: 20 vs 8, enemy loses 2 per round -> 4 rounds.
  const faces = [6, 6, 1, 1, 6, 6, 1, 1, 6, 6, 1, 1, 6, 6, 1, 1];
  const { engine, store, adventure } = makeEngine({ faces });
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "goblin_toll_path";

  const step = await engine.walk(run_id, "r028", 0);
  const encounter = adventure.doc.encounters.find((e) => e.id === "goblin_toll_collectors");
  assert.equal(step.resolution.type, "combat");
  assert.equal(step.resolution.encounter_id, "goblin_toll_collectors");
  assert.equal(step.resolution.encounter_name, encounter.name);
  assert.equal(step.resolution.encounter_kind, encounter.kind);
  assert.equal(step.resolution.special, encounter.special);
  assert.deepEqual(step.resolution.narrative, encounter.narrative_semantics);
  assert.equal(step.resolution.success, true);
  assert.equal(step.resolution.rounds.length, 4);
  assert.deepEqual(step.resolution.rounds[0], {
    player_rolls: [6, 6],
    enemy_rolls: [1, 1],
    player_attack: 20,
    enemy_attack: 8,
    damage_to: "enemy",
    damage: 2,
    player_stamina_after: 16,
    enemy_stamina_after: 5,
  });
  assert.equal(step.resolution.rounds[3].enemy_stamina_after, 0);
  assert.equal(step.to, "old_quarry_entrance");
  assert.equal(step.state_after.stats.reputation, -1); // victory effect
  assert.equal(step.status_after, "active");
});

test("combat death: stamina 0 fails the test and the death invariant completes the run", async () => {
  // Enemy wins every round: player 1+1 (10), enemy 6+6 (18); 16 stamina -> 8 rounds.
  const faces = Array.from({ length: 8 }, () => [1, 1, 6, 6]).flat();
  const { engine, store } = makeEngine({ faces });
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  stored(store, run_id).state.current_node = "goblin_toll_path";

  const step = await engine.walk(run_id, "r028", 0);
  assert.equal(step.resolution.success, false);
  assert.equal(step.resolution.rounds.length, 8);
  assert.equal(step.state_after.stats.stamina, 0);
  assert.equal(step.to, "ending_dead");
  assert.equal(step.status_after, "completed");
  assert.equal(step.state_after.current_node, "ending_dead");

  // Completed runs still serve get_node (to narrate the ending) with no routes,
  // but refuse walk.
  const view = await engine.getNode(run_id);
  assert.equal(view.status, "completed");
  assert.equal(view.node.id, "ending_dead");
  assert.deepEqual(view.available_routes, []);
  await rejects(engine.walk(run_id, "r001", 1), "run_not_active");
});

test("a write conflict discards the resolution entirely", async () => {
  const store = new MemoryRunStore();
  const { engine } = makeEngine({ store });
  const { run_id } = await engine.newRun(ADVENTURE_ID);

  const realUpdate = store.update.bind(store);
  store.update = async () => {
    throw new StoreConflictError();
  };
  await rejects(engine.walk(run_id, "r001", 0), "conflict");
  store.update = realUpdate;

  const doc = stored(store, run_id);
  assert.equal(doc.revision, 0);
  assert.equal(doc.state.current_node, "barrowgate_square");
  assert.deepEqual(doc.log, []);

  // The caller re-fetches and retries successfully.
  const view = await engine.getNode(run_id);
  const step = await engine.walk(run_id, "r001", view.revision);
  assert.equal(step.to, "bent_nail_inn");
});

test("adventure hash mismatch: get_node/walk hard-stop, get_log still serves the log", async () => {
  const { engine, store, adventure } = makeEngine();
  const { run_id } = await engine.newRun(ADVENTURE_ID);
  await engine.walk(run_id, "r001", 0);
  stored(store, run_id).adventure_hash = "sha256:0000";

  const err = await rejects(engine.getNode(run_id), "adventure_mismatch");
  assert.equal(err.extra.run_adventure_hash, "sha256:0000");
  assert.equal(err.extra.deployed_adventure_hash, adventure.hash);
  await rejects(engine.walk(run_id, "r010", 1), "adventure_mismatch");

  const log = await engine.getLog(run_id);
  assert.equal(log.adventure_mismatch, true);
  assert.equal(log.run_adventure_hash, "sha256:0000");
  assert.equal(log.deployed_adventure_hash, adventure.hash);
  assert.equal(log.log.length, 1);
});

test("unknown run ids are reported as run_not_found", async () => {
  const { engine } = makeEngine();
  await rejects(engine.getNode("no-such-run"), "run_not_found");
  await rejects(engine.walk("no-such-run", "r001", 0), "run_not_found");
  await rejects(engine.getLog("no-such-run"), "run_not_found");
});
