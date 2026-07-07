"use strict";

// Regression tests for the multi-adventure playtest assessment: blocked-route
// disclosure, the ending-assertion lint, and the four adventures' confirmed
// state defects (repeatable counterfeit permit, premature MERIDIAN payoff,
// endings that narrated state they never set, and the audit's invisible
// ink/certification gates).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { loadAdventures, validateAdventure } = require("../src/engine/adventure");
const { createEngine } = require("../src/engine/engine");
const { MemoryRunStore } = require("../src/storage/memoryRunStore");
const { EngineError } = require("../src/engine/errors");
const { scriptedDice } = require("./helpers");

const MANIFEST_PATH = path.join(__dirname, "..", "adventures", "manifest.json");
const adventures = loadAdventures(MANIFEST_PATH);

function makeMultiEngine({ faces, store = new MemoryRunStore() } = {}) {
  const engine = createEngine({
    adventures,
    store,
    randomInt: scriptedDice(faces ?? []),
    now: () => "2026-07-07T12:00:00Z",
  });
  return { engine, store };
}

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

// ---------------------------------------------------------------------------
// Blocked-route disclosure
// ---------------------------------------------------------------------------

test("a 'blocked' route surfaces its exact unmet conditions and costs", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("dragons-ledger-audit");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "weighbridge";
  doc.state.resources.ink = 0;

  const view = await engine.getNode(run.run_id);
  assert.ok(view.blocked_routes, "expected blocked_routes at the weighbridge");
  const certify = view.blocked_routes.find((b) =>
    b.label.startsWith("Certify the counter-weights")
  );
  assert.ok(certify, "d060 should be disclosed while blocked");
  assert.equal(certify.disclosure, "blocked");
  assert.match(certify.reason, /The Dusk Wagons/);
  assert.match(certify.reason, /requires 1 ink \(you have 0\)/);
  // Blocked entries carry no route id and are not walkable.
  assert.equal(certify.id, undefined);
});

test("a disclosed route moves from blocked_routes to available_routes once its gates pass", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("dragons-ledger-audit");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "weighbridge";
  doc.state.resources.ink = 2;
  doc.state.knowledge.push("freight_pattern");

  const view = await engine.getNode(run.run_id);
  assert.ok(view.available_routes.some((r) => r.id === "d060"));
  assert.ok(!(view.blocked_routes ?? []).some((b) => b.label.startsWith("Certify")));
});

test("a 'foreshadowed' route reveals only its authored hint, never the requirement", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("hollow-market-tithe");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "mirror_canal";

  const view = await engine.getNode(run.run_id);
  const crossing = (view.blocked_routes ?? []).find((b) => b.disclosure === "foreshadowed");
  assert.ok(crossing, "h080 should be foreshadowed at the Mirror Canal");
  assert.ok(crossing.hint.length > 0);
  assert.equal(crossing.reason, undefined);
  assert.ok(!("conditions" in crossing));
  // h081 (the jar) is fully blocked-disclosed with the exact missing item.
  const jar = (view.blocked_routes ?? []).find((b) => b.disclosure === "blocked");
  assert.ok(jar, "h081 should be disclosed as blocked");
  assert.match(jar.reason, /Jar of First Frost/);
});

test("routes without disclosure stay hidden when their gates fail", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("vienna-clearing-house");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "safehouse_margareten";

  const view = await engine.getNode(run.run_id);
  // r017 (signal MERIDIAN) fails its conditions and declares no disclosure.
  assert.ok(!view.available_routes.some((r) => r.id === "r017"));
  assert.ok(!(view.blocked_routes ?? []).some((b) => b.label.includes("Signal MERIDIAN")));
});

// ---------------------------------------------------------------------------
// Ending-assertion lint
// ---------------------------------------------------------------------------

function syntheticAdventure(routes, endingAssertions) {
  const nodes = [
    { id: "start", title: "Start", summary: "" },
    { id: "ending_good", title: "Good", summary: "" },
    { id: "ending_dead", title: "Dead", summary: "" },
  ];
  const doc = {
    graph: { id: "synthetic", entry_node: "start", terminal_nodes: ["ending_good", "ending_dead"] },
    ruleset: {
      player_state: {
        stats: { skill: { initial: 8 }, stamina: { min: 0, initial: 10 }, luck: { initial: 8 } },
        resources: {},
        collections: {
          inventory: { initial: [] },
          conditions: { initial: [] },
          knowledge: { initial: [] },
        },
        flags: { done: { type: "boolean", initial: false } },
      },
    },
    items: [{ id: "prize", name: "Prize", description: "" }],
    encounters: [],
    nodes,
    routes,
    validation: { ending_assertions: endingAssertions },
  };
  return {
    doc,
    id: "synthetic",
    entryNode: "start",
    terminalNodes: new Set(doc.graph.terminal_nodes),
    nodesById: new Map(nodes.map((n) => [n.id, n])),
    routesById: new Map(routes.map((r) => [r.id, r])),
    encountersById: new Map(),
    itemsById: new Map(doc.items.map((i) => [i.id, i])),
  };
}

test("the lint flags an ending route that never guarantees the asserted flag", () => {
  const adventure = syntheticAdventure(
    [{ id: "x1", from: "start", to: "ending_good", label: "win", effects: [] }],
    { ending_good: [{ flag: "done", value: true }] }
  );
  const errors = validateAdventure(adventure);
  assert.ok(
    errors.some((e) => e.includes("x1") && e.includes("done")),
    `expected an assertion error, got: ${errors.join(" | ")}`
  );
});

test("the lint accepts set-flag, required-flag and item-witness guarantees", () => {
  const adventure = syntheticAdventure(
    [
      // Guaranteed by setting the flag on arrival.
      {
        id: "x1",
        from: "start",
        to: "ending_good",
        label: "set",
        effects: [{ op: "set_flag", flag: "done", value: true }],
      },
      // Guaranteed by requiring the flag.
      {
        id: "x2",
        from: "start",
        to: "ending_good",
        label: "require",
        conditions: [{ op: "flag_is", flag: "done", value: true }],
        effects: [],
      },
      // Guaranteed through the item witness: every route granting the item
      // also sets the flag.
      {
        id: "grant",
        from: "start",
        to: "start",
        label: "grant",
        effects: [
          { op: "add_item", item: "prize" },
          { op: "set_flag", flag: "done", value: true },
        ],
      },
      {
        id: "x3",
        from: "start",
        to: "ending_good",
        label: "witness",
        conditions: [{ op: "has_item", item: "prize" }],
        effects: [],
      },
    ],
    { ending_good: [{ flag: "done", value: true }] }
  );
  assert.deepEqual(validateAdventure(adventure), []);
});

test("the lint refuses assertions on ending_dead", () => {
  const adventure = syntheticAdventure([], { ending_dead: [{ flag: "done", value: true }] });
  const errors = validateAdventure(adventure);
  assert.ok(errors.some((e) => e.includes("ending_dead") && e.includes("unsound")));
});

// ---------------------------------------------------------------------------
// Rust Wind Hills: the counterfeit permit is a one-shot purchase
// ---------------------------------------------------------------------------

test("the counterfeit permit cannot be bought twice", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("rust-wind-hills-dungeon");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "forgery_cellar";

  const first = await engine.walk(run.run_id, "r018", 0);
  assert.equal(first.state_after.flags.permit_status, "counterfeit");
  const goldAfter = first.state_after.resources.gold;

  // Back to the cellar: the purchase must no longer be offered or walkable.
  stored(store, run.run_id).state.current_node = "forgery_cellar";
  const view = await engine.getNode(run.run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "r018"));
  await rejects(engine.walk(run.run_id, "r018", 1), "route_unavailable");
  assert.equal(stored(store, run.run_id).state.resources.gold, goldAfter);
});

test("a licensed delver is never offered the forgery", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("rust-wind-hills-dungeon");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "forgery_cellar";
  doc.state.flags.permit_status = "licensed";
  const view = await engine.getNode(run.run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "r018"));
});

// ---------------------------------------------------------------------------
// Rust Wind Hills: settled encounters do not pay out twice
// ---------------------------------------------------------------------------

test("the pit beast dies once; afterwards the pits are an unopposed crossing", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("rust-wind-hills-dungeon");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "beast_pits";

  // Beast alive: the fight is offered, the crossing is not.
  let view = await engine.getNode(run.run_id);
  assert.ok(view.available_routes.some((r) => r.id === "r074"));
  assert.ok(!view.available_routes.some((r) => r.id === "r109"));

  // Beast dead: the fight is gone (no reputation farming), the crossing opens.
  doc.state.flags.pit_beast_dead = true;
  view = await engine.getNode(run.run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "r074"), "no second beast fight");
  assert.ok(view.available_routes.some((r) => r.id === "r109"), "the crossing replaces it");

  const repBefore = doc.state.stats.reputation;
  const cross = await engine.walk(run.run_id, "r109", 0);
  assert.equal(cross.to, "black_wind_forge");
  assert.equal(cross.state_after.stats.reputation, repBefore, "the crossing pays nothing");
});

test("the Guardian is dealt with once; the opened Ninth Lock stays passable", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("rust-wind-hills-dungeon");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "guardian_ninth_lock";
  doc.state.knowledge.push("lawful_release_phrase");
  doc.state.inventory.push("brass_seal");

  const release = await engine.walk(run.run_id, "r091", 0);
  assert.equal(release.state_after.flags.ninth_lock_open, true);
  const repAfter = release.state_after.stats.reputation;

  stored(store, run.run_id).state.current_node = "guardian_ninth_lock";
  const view = await engine.getNode(run.run_id);
  for (const gone of ["r090", "r091", "r092"]) {
    assert.ok(!view.available_routes.some((r) => r.id === gone), `${gone} must be settled`);
  }
  assert.ok(view.available_routes.some((r) => r.id === "r110"), "the open Lock is passable");

  const descend = await engine.walk(run.run_id, "r110", 1);
  assert.equal(descend.to, "abyssal_stair");
  assert.equal(descend.state_after.stats.reputation, repAfter, "no reputation farming");
});

// ---------------------------------------------------------------------------
// The Clearing House: the trust payoff happens at the meeting, not before it
// ---------------------------------------------------------------------------

test("waiting at the staff exit arranges the meeting; the proof earns the window", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("vienna-clearing-house");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "clearing_bank_lobby";
  doc.state.knowledge.push("drop_schedule");

  const arrange = await engine.walk(run.run_id, "r033", 0);
  assert.equal(arrange.to, "meridian_meeting");
  assert.equal(arrange.state_after.flags.meridian_trust, "wary");
  assert.ok(arrange.state_after.knowledge.includes("meridian_terms"));
  assert.ok(
    !arrange.state_after.knowledge.includes("exfil_window"),
    "the exfil window is not given away before the proof"
  );

  const prove = await engine.walk(run.run_id, "r040", 1);
  assert.equal(prove.state_after.flags.meridian_trust, "convinced");
  assert.ok(prove.state_after.knowledge.includes("exfil_window"));
});

// ---------------------------------------------------------------------------
// Hollow Market: endings set the state their narration asserts
// ---------------------------------------------------------------------------

test("the changeling swap restores the sister's name in terminal state", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("hollow-market-tithe");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "thorn_court";
  doc.state.knowledge.push("queens_price");

  const swap = await engine.walk(run.run_id, "h073", 0);
  assert.equal(swap.status_after, "completed");
  assert.equal(swap.to, "ending_changeling_swap");
  assert.equal(swap.state_after.flags.name_located, true);
  assert.equal(swap.state_after.flags.name_recovered, true);
  assert.equal(swap.state_after.flags.oath_status, "bound");
  assert.equal(swap.state_after.flags.court_standing, "claimed");
});

test("the bound-knight bargain restores the name and swears the oath", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("hollow-market-tithe");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "thorn_court";
  doc.state.knowledge.push("queens_price");

  const swear = await engine.walk(run.run_id, "h072", 0);
  assert.equal(swear.to, "ending_bound_knight");
  assert.equal(swear.state_after.flags.name_recovered, true);
  assert.equal(swear.state_after.flags.oath_status, "sworn");
  assert.equal(swear.state_after.flags.court_standing, "favoured");
});

// ---------------------------------------------------------------------------
// The Dragon's Ledger: the descent distinguishes empty-handed from uncertified
// ---------------------------------------------------------------------------

test("with a quantified shortfall the descent files a preliminary finding, not 'nothing proven'", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("dragons-ledger-audit");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "descent_road";

  let view = await engine.getNode(run.run_id);
  assert.ok(view.available_routes.some((r) => r.id === "d101"), "empty-handed exit offered");
  assert.ok(!view.available_routes.some((r) => r.id === "d103"));

  stored(store, run.run_id).state.knowledge.push("hoard_shortfall");
  view = await engine.getNode(run.run_id);
  assert.ok(!view.available_routes.some((r) => r.id === "d101"), "'nothing proven' no longer fits");
  assert.ok(view.available_routes.some((r) => r.id === "d103"), "the preliminary filing replaces it");

  const file = await engine.walk(run.run_id, "d103", 0);
  assert.equal(file.to, "ending_guild_disgrace");
  // The evidence-laden arrival gets the variant narration, not the
  // empty-handed read_aloud.
  assert.match(file.node.read_aloud, /the number is right/);
});

test("ink is purchasable inside the mountain, so certification can't deadlock", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("dragons-ledger-audit");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "counting_caverns";
  doc.state.resources.ink = 0;

  const buy = await engine.walk(run.run_id, "d038", 0);
  assert.equal(buy.state_after.resources.ink, 4);

  // Broke and dry, the purchase is disclosed as blocked rather than hidden.
  const broke = stored(store, run.run_id);
  broke.state.resources.ink = 0;
  broke.state.resources.gold = 1;
  const view = await engine.getNode(run.run_id);
  const bottle = (view.blocked_routes ?? []).find((b) => b.label.includes("audit ink"));
  assert.ok(bottle, "the ink purchase should be visible while unaffordable");
  assert.match(bottle.reason, /requires 4 gold \(you have 1\)/);
});

test("signing Maurice's filing is one-shot", async () => {
  const { engine, store } = makeMultiEngine();
  const run = await engine.newRun("dragons-ledger-audit");
  const doc = stored(store, run.run_id);
  doc.state.current_node = "comptroller_office";

  const sign = await engine.walk(run.run_id, "d071", 0);
  assert.equal(sign.state_after.flags.audit_status, "filed_false");
  const goldAfter = sign.state_after.resources.gold;

  stored(store, run.run_id).state.current_node = "comptroller_office";
  await rejects(engine.walk(run.run_id, "d071", 1), "route_unavailable");
  assert.equal(stored(store, run.run_id).state.resources.gold, goldAfter, "no double payday");
});
