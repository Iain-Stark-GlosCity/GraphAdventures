"use strict";

const crypto = require("node:crypto");

const { EngineError, StoreConflictError, routeUnavailable } = require("./errors");
const { allPass } = require("./conditions");
const { applyEffects, applyKnowledgeGrants } = require("./effects");
const { makeRoller } = require("./dice");
const { resolveTest } = require("./resolve");
const { initialState } = require("./adventure");

const RUN_SCHEMA_VERSION = "1.0";

/**
 * The game engine behind the four MCP tools. Pure of any hosting concern:
 * storage, clock and dice are injected so tests can drive it
 * deterministically against an in-memory store.
 *
 * store contract:
 *   create(runId, doc)        -> rejects if the run already exists
 *   read(runId)               -> { doc, etag } | null
 *   update(runId, doc, etag)  -> throws StoreConflictError on ETag mismatch
 */
function createEngine({ adventure, store, now = () => new Date().toISOString(), randomInt, log = () => {} }) {
  const roll = makeRoller(randomInt);

  async function loadRun(runId) {
    const found = await store.read(runId);
    if (!found) throw new EngineError("run_not_found", `No run with id ${runId}.`);
    return found;
  }

  function adventureMismatch(doc) {
    return (
      doc.adventure_id !== adventure.id ||
      doc.adventure_version !== adventure.version ||
      doc.adventure_hash !== adventure.hash
    );
  }

  function assertAdventureMatches(doc) {
    if (adventureMismatch(doc)) {
      throw new EngineError(
        "adventure_mismatch",
        "This run was created against a different version of the adventure content.",
        {
          run_adventure_hash: doc.adventure_hash,
          deployed_adventure_hash: adventure.hash,
        }
      );
    }
  }

  // The four availability checks used by get_node; walk re-runs them
  // individually so it can log the precise internal reason.
  function isVisible(route, state) {
    return !route.visibility || allPass(route.visibility.conditions, state);
  }
  function isLegal(route, state) {
    return allPass(route.conditions, state);
  }
  function isAffordable(route, state) {
    return (route.costs ?? []).every((c) => state.resources[c.resource] >= c.amount);
  }
  function isNotConsumed(route, state) {
    return !state.consumed_routes.includes(route.id);
  }

  // Public route projection: never expose failure_to, failure_effects or
  // visibility details.
  function publicRoute(route) {
    let test = null;
    if (route.test) {
      test =
        route.test.type === "combat"
          ? { type: "combat", encounter_id: route.test.encounter_id }
          : { type: route.test.type, stat: route.test.stat, modifier: route.test.modifier ?? 0 };
    }
    return {
      id: route.id,
      label: route.label,
      costs: structuredClone(route.costs ?? []),
      test,
    };
  }

  function publicState(state) {
    const { current_node, consumed_routes, ...rest } = state;
    return structuredClone(rest);
  }

  function publicNode(node) {
    const out = { id: node.id, title: node.title, summary: node.summary };
    // Explicit read_aloud (hand-authored, only on a handful of nodes) wins
    // where present; narrative.arrival_text (added in content revision
    // 0.2.0, present on every node) fills in everywhere else, so a caller
    // always gets proper arrival prose to read out rather than falling
    // back to summary.
    const readAloud = node.read_aloud ?? node.narrative?.arrival_text;
    if (readAloud) out.read_aloud = readAloud;
    return out;
  }

  async function newRun(adventureId, label = null) {
    if (adventureId !== adventure.id) {
      throw new EngineError(
        "unknown_adventure",
        `Unknown adventure ${adventureId}; this server hosts ${adventure.id}.`
      );
    }
    const runId = crypto.randomBytes(16).toString("base64url");
    const state = initialState(adventure);
    const entryNode = adventure.nodesById.get(adventure.entryNode);
    const arrivalEffects = applyKnowledgeGrants(entryNode, state);
    const timestamp = now();
    const doc = {
      schema_version: RUN_SCHEMA_VERSION,
      run_id: runId,
      label: label ?? null,
      adventure_id: adventure.id,
      adventure_version: adventure.version,
      adventure_hash: adventure.hash,
      revision: 0,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
      state,
      log: [],
    };
    await store.create(runId, doc);
    return {
      run_id: runId,
      label: doc.label,
      adventure_id: doc.adventure_id,
      adventure_version: doc.adventure_version,
      adventure_hash: doc.adventure_hash,
      revision: 0,
      status: "active",
      node: publicNode(entryNode),
      state: publicState(state),
      arrival_effects_applied: arrivalEffects,
    };
  }

  // Shared by get_node and walk's response (not by what walk persists to
  // doc.log — see the comment on walk's return below). Needs only the
  // state already held in memory, no storage read.
  function availableRoutesFor(state, status) {
    if (status !== "active") return [];
    return (adventure.routesByFrom.get(state.current_node) ?? [])
      .filter(
        (r) =>
          isVisible(r, state) &&
          isLegal(r, state) &&
          isAffordable(r, state) &&
          isNotConsumed(r, state)
      )
      .map(publicRoute);
  }

  // Strictly read-only: no mutation, no revision bump, no ETag write. Also
  // serves completed runs (with no routes) so the caller can narrate the
  // ending after the final walk.
  async function getNode(runId) {
    const { doc } = await loadRun(runId);
    assertAdventureMatches(doc);
    const state = doc.state;
    const node = adventure.nodesById.get(state.current_node);
    return {
      run_id: doc.run_id,
      revision: doc.revision,
      status: doc.status,
      state: publicState(state),
      node: publicNode(node),
      available_routes: availableRoutesFor(state, doc.status),
    };
  }

  async function walk(runId, routeId, expectedRevision) {
    const { doc, etag } = await loadRun(runId);
    assertAdventureMatches(doc);
    if (doc.status !== "active") {
      throw new EngineError("run_not_active", `Run ${runId} is ${doc.status}.`);
    }
    const revision = Number(expectedRevision);
    if (!Number.isInteger(revision) || revision !== doc.revision) {
      throw new EngineError(
        "revision_conflict",
        "expected_revision does not match the run's current revision.",
        { expected_revision: expectedRevision, current_revision: doc.revision }
      );
    }

    // Steps 5-9: any failure collapses into the same generic error so the
    // response never distinguishes unknown / wrong-node / hidden / illegal /
    // consumed / unaffordable. Only the server log gets the real reason.
    const state = doc.state;
    const route = adventure.routesById.get(routeId);
    const unavailable = !route
      ? "unknown route id"
      : route.from !== state.current_node
        ? "route does not start at the current node"
        : !isVisible(route, state)
          ? "route is hidden"
          : !isLegal(route, state)
            ? "route conditions not met"
            : !isNotConsumed(route, state)
              ? "route already consumed"
              : !isAffordable(route, state)
                ? "route costs not affordable"
                : null;
    if (unavailable) {
      log(`walk(${runId}, ${routeId}): route_unavailable (${unavailable})`);
      throw routeUnavailable();
    }

    // Costs are spent on the attempt, before the test resolves.
    const costsApplied = [];
    for (const cost of route.costs ?? []) {
      state.resources[cost.resource] -= cost.amount;
      costsApplied.push({ resource: cost.resource, amount: -cost.amount });
    }
    if (route.one_time) state.consumed_routes.push(route.id);

    const { resolution, success } = resolveTest(route.test, state, adventure, roll);

    const effects = success ? (route.effects ?? []) : (route.test.failure_effects ?? []);
    const effectsApplied = applyEffects(effects, state, adventure);

    let destination = success ? route.to : route.test.failure_to;
    let status = "active";
    if (state.stats.stamina <= 0) {
      destination = "ending_dead";
      status = "completed";
    }
    state.current_node = destination;
    const destinationNode = adventure.nodesById.get(destination);
    const arrivalEffects = applyKnowledgeGrants(destinationNode, state);
    if (adventure.terminalNodes.has(destination)) status = "completed";

    doc.revision += 1;
    doc.status = status;
    const committedAt = now();
    doc.updated_at = committedAt;
    const step = {
      step_id: crypto.randomBytes(6).toString("hex"),
      revision_before: revision,
      revision_after: doc.revision,
      status_after: status,
      committed_at: committedAt,
      from: route.from,
      route_id: route.id,
      costs_applied: costsApplied,
      resolution,
      to: destination,
      effects_applied: effectsApplied,
      arrival_effects_applied: arrivalEffects,
      state_after: structuredClone(state),
    };
    doc.log.push(step);

    try {
      await store.update(runId, doc, etag);
    } catch (e) {
      if (e instanceof StoreConflictError) {
        // Discard the resolution entirely — never return an uncommitted
        // roll as though it happened. The caller re-fetches and retries.
        log(`walk(${runId}, ${routeId}): ETag conflict, resolution discarded`);
        throw new EngineError(
          "conflict",
          "The run was modified concurrently; re-fetch with get_node and retry."
        );
      }
      throw e;
    }

    // The step above is exactly what's persisted in doc.log — get_log will
    // always return that unmodified. node and available_routes are computed
    // fresh from the state already in memory (no extra storage read) and
    // appended only to this live response, so the common case of "walk,
    // then narrate" doesn't need a follow-up get_node round trip. They are
    // never written to the log.
    return {
      ...step,
      node: publicNode(destinationNode),
      available_routes: availableRoutesFor(state, status),
    };
  }

  // Exempt from the adventure-hash hard-stop: still returns the log, just
  // flagged, when the deployed content has moved on.
  async function getLog(runId) {
    const { doc } = await loadRun(runId);
    const result = {
      run_id: doc.run_id,
      revision: doc.revision,
      status: doc.status,
      log: doc.log,
    };
    if (adventureMismatch(doc)) {
      result.adventure_mismatch = true;
      result.run_adventure_hash = doc.adventure_hash;
      result.deployed_adventure_hash = adventure.hash;
    }
    return result;
  }

  return { newRun, getNode, walk, getLog };
}

module.exports = { createEngine };
