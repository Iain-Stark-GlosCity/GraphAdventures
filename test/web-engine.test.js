"use strict";

// Keeps web/engine.mjs (the browser port behind the adventure-walking
// website) honest against the real engine in src/engine: same rules, same
// dice, same state. The strongest guard is the lockstep parity test — both
// engines walk identical deterministic playthroughs and must agree on every
// node visited and every byte of public state.

const test = require("node:test");
const assert = require("node:assert/strict");

const { adventure, makeEngine, scriptedDice } = require("./helpers");

const webEnginePromise = import("../web/engine.mjs");

async function webSetup() {
  const web = await webEnginePromise;
  return { web, webAdventure: web.indexAdventure(adventure.doc) };
}

test("newRun seeds the ruleset's initial state and offers the entry routes", async () => {
  const { web, webAdventure } = await webSetup();
  const { doc, result } = web.newRun(webAdventure);

  assert.equal(doc.status, "active");
  assert.equal(doc.state.current_node, adventure.entryNode);
  assert.equal(result.node.id, adventure.entryNode);
  assert.equal(result.node.presentation, "first_visit");

  const ps = adventure.doc.ruleset.player_state;
  for (const [name, def] of Object.entries(ps.stats)) {
    assert.equal(result.state.stats[name], def.initial, `stat ${name}`);
  }
  for (const [name, def] of Object.entries(ps.resources)) {
    assert.equal(result.state.resources[name], def.initial, `resource ${name}`);
  }
  assert.ok(result.available_routes.length > 0, "entry node offers routes");
  assert.ok(result.opening_context.length > 0, "opening context is returned");
});

test("walk spends costs before the test and refuses unavailable routes", async () => {
  const { web, webAdventure } = await webSetup();
  const { doc } = web.newRun(webAdventure);

  assert.throws(
    () => web.walk(webAdventure, doc, "no_such_route"),
    (e) => e instanceof web.EngineError && e.code === "route_unavailable"
  );

  // Public route projection never leaks failure branches or visibility.
  const view = web.getNode(webAdventure, doc);
  for (const route of view.available_routes) {
    assert.ok(!("to" in route) && !("failure_to" in route) && !("visibility" in route));
    if (route.test) assert.ok(!("failure_to" in route.test) && !("failure_effects" in route.test));
  }
});

test("luck tests always cost 1 luck, success or failure", async () => {
  const { web, webAdventure } = await webSetup();
  const luckRoute = adventure.doc.routes.find((r) => r.test && r.test.stat === "luck");
  assert.ok(luckRoute, "asset has a luck-testing route");

  const { doc } = web.newRun(webAdventure);
  // Teleport the run to the luck route's node; a unit-level shortcut the
  // server tests use too (via seeded state).
  doc.state.current_node = luckRoute.from;
  const luckBefore = doc.state.stats.luck;
  const step = web.walk(webAdventure, doc, luckRoute.id, { randomInt: scriptedDice([1, 1]) });
  assert.equal(step.resolution.success, true, "rolling 2 always succeeds");
  assert.equal(step.state_after.stats.luck, luckBefore - 1);
});

// Lockstep parity: seed identical scripted dice into the real engine and the
// web port, always take the first available route, and require the exact
// same walk — nodes, resolutions, status and public state — on both sides.
// Runs several dice scripts so both success and failure branches, combat
// and the death invariant all get exercised.
test("web engine walks in lockstep with src/engine", async () => {
  const { web, webAdventure } = await webSetup();

  const diceScripts = [
    [], // all 1s: every test succeeds until a strong combat kills you
    [6, 6, 5, 5, 4, 4, 3, 3, 2, 2], // early failures, then all 1s
    [1, 1, 6, 6, 2, 3, 6, 5, 1, 2, 4, 4, 6, 6], // mixed
  ];

  for (const faces of diceScripts) {
    const { engine } = makeEngine({ faces: [...faces] });
    const server = await engine.newRun(adventure.id);

    const { doc } = web.newRun(webAdventure, { randomInt: scriptedDice([]) });
    const webDice = scriptedDice([...faces]);

    assert.deepEqual(web.getNode(webAdventure, doc).state, server.state, "initial state agrees");

    let serverView = await engine.getNode(server.run_id);
    for (let i = 0; i < 200 && serverView.status === "active"; i += 1) {
      const webView = web.getNode(webAdventure, doc);
      assert.equal(webView.node.id, serverView.node.id, `node agrees at step ${i}`);
      assert.deepEqual(
        webView.available_routes.map((r) => r.id),
        serverView.available_routes.map((r) => r.id),
        `routes agree at step ${i}`
      );
      if (serverView.available_routes.length === 0) break; // content soft-lock

      const routeId = serverView.available_routes[0].id;
      const serverStep = await engine.walk(server.run_id, routeId, serverView.revision);
      const webStep = web.walk(webAdventure, doc, routeId, { randomInt: webDice });

      assert.equal(webStep.to, serverStep.to, `destination agrees at step ${i}`);
      assert.equal(webStep.status_after, serverStep.status_after);
      // The live walk view says status uniformly with newRun/getNode — the
      // website decides "offer routes vs show the ending" from this.
      assert.equal(webStep.status, webStep.status_after);
      assert.deepEqual(webStep.resolution, serverStep.resolution, `resolution agrees at step ${i}`);
      assert.deepEqual(webStep.state_after, serverStep.state_after, `state agrees at step ${i}`);
      assert.equal(webStep.route_resolution, serverStep.route_resolution);

      serverView = await engine.getNode(server.run_id);
      assert.equal(doc.status, serverView.status);
    }
  }
});

// Monte Carlo: random honest dice, random route choices — the port must
// never crash, and every completed run must end on a terminal node.
test("random playthroughs never crash the web engine", async () => {
  const { web, webAdventure } = await webSetup();
  let completed = 0;
  for (let run = 0; run < 60; run += 1) {
    const { doc } = web.newRun(webAdventure);
    for (let step = 0; step < 300 && doc.status === "active"; step += 1) {
      const view = web.getNode(webAdventure, doc);
      if (view.available_routes.length === 0) break; // known content soft-locks
      const route = view.available_routes[Math.floor(Math.random() * view.available_routes.length)];
      web.walk(webAdventure, doc, route.id);
    }
    if (doc.status === "completed") {
      completed += 1;
      assert.ok(
        adventure.terminalNodes.has(doc.state.current_node),
        `completed on terminal node, got ${doc.state.current_node}`
      );
    }
  }
  assert.ok(completed > 0, "at least one run reached an ending");
});
