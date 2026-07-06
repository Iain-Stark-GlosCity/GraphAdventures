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
 * The game engine behind the MCP tools. Pure of any hosting concern:
 * storage, clock and dice are injected so tests can drive it
 * deterministically against an in-memory store.
 *
 * The engine hosts one or more adventures at once — pass `adventures` (an
 * array) or `adventure` (a single one; kept as sugar so single-adventure
 * tests and scripts read naturally). Every run records which adventure it
 * belongs to (id + version + hash); new_run dispatches on adventure_id and
 * the run-scoped tools resolve the right adventure from the run document,
 * so runs of different adventures share one store without ever crossing.
 *
 * store contract:
 *   create(runId, doc)        -> rejects if the run already exists
 *   read(runId)               -> { doc, etag } | null
 *   update(runId, doc, etag)  -> throws StoreConflictError on ETag mismatch
 */
function createEngine({ adventure, adventures, store, now = () => new Date().toISOString(), randomInt, log = () => {} }) {
  const hosted = adventures ?? (adventure ? [adventure] : []);
  if (hosted.length === 0) {
    throw new Error("createEngine requires at least one adventure (pass adventure or adventures)");
  }
  const adventuresById = new Map(hosted.map((a) => [a.id, a]));
  if (adventuresById.size !== hosted.length) {
    throw new Error("createEngine was given duplicate adventure ids");
  }
  const roll = makeRoller(randomInt);

  async function loadRun(runId) {
    const found = await store.read(runId);
    if (!found) throw new EngineError("run_not_found", `No run with id ${runId}.`);
    return found;
  }

  // A run matches only the exact content it was created against: same id,
  // same version, same byte hash. A hosted adventure with the same id but
  // different bytes is still a mismatch — formatting-only edits
  // intentionally invalidate existing runs.
  function adventureForRunOrNull(doc) {
    const candidate = adventuresById.get(doc.adventure_id);
    if (!candidate) return null;
    if (doc.adventure_version !== candidate.version || doc.adventure_hash !== candidate.hash) return null;
    return candidate;
  }

  function adventureForRun(doc) {
    const candidate = adventureForRunOrNull(doc);
    if (!candidate) {
      throw new EngineError(
        "adventure_mismatch",
        "This run was created against adventure content this server no longer hosts in that exact version.",
        {
          run_adventure_id: doc.adventure_id,
          run_adventure_hash: doc.adventure_hash,
          deployed_adventure_hash: adventuresById.get(doc.adventure_id)?.hash ?? null,
        }
      );
    }
    return candidate;
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
  function publicRoute(adventure, route) {
    let test = null;
    if (route.test) {
      if (route.test.type === "combat") {
        const encounter = adventure.encountersById.get(route.test.encounter_id);
        test = {
          type: "combat",
          encounter_id: route.test.encounter_id,
          encounter_name: encounter.name,
          encounter_kind: encounter.kind,
        };
      } else {
        test = { type: route.test.type, stat: route.test.stat, modifier: route.test.modifier ?? 0 };
      }
    }
    const out = {
      id: route.id,
      label: route.label,
      costs: structuredClone(route.costs ?? []),
      test,
    };
    // stakes/hook (content revision 0.2.2): player-facing cost/risk/
    // opportunity framing and a short flavour line, meant to sit alongside
    // the short mechanical label rather than replace it. Verified across
    // every adventure's routes to carry no hidden-destination detail.
    if (route.stakes) out.stakes = route.stakes;
    if (route.hook) out.hook = route.hook;
    // Route-level narrative (player_intent, dramatic_role, continuity_refs,
    // narration_guidance and similar) — verified across every route to
    // carry no hidden-destination or condition detail, only flavour for
    // whatever's narrating this choice. content_role is schema
    // documentation about what label/stakes/hook are for, not game
    // content — dropped rather than passed through as if it were flavour.
    if (route.narrative) {
      const { content_role, ...rest } = route.narrative;
      if (Object.keys(rest).length > 0) out.narrative = rest;
    }
    return out;
  }

  function publicState(state) {
    const { current_node, consumed_routes, visited_nodes, ...rest } = state;
    return structuredClone(rest);
  }

  // Records an arrival and returns the resulting visit count for that node,
  // so the engine — not the caller's memory of the conversation — decides
  // first-visit vs revisit presentation. Self-healing on visited_nodes so a
  // run persisted before this field existed doesn't crash the first time
  // it's walked under the new engine code.
  function visitNode(state, nodeId) {
    state.visited_nodes ??= {};
    state.visited_nodes[nodeId] = (state.visited_nodes[nodeId] ?? 0) + 1;
    return state.visited_nodes[nodeId];
  }

  // Adds narrative flavour to add_item and add_knowledge effect records —
  // computed fresh from the adventure asset for a live response only, same
  // as node/available_routes below. What's actually persisted in doc.log
  // (see the step object in walk, and get_log) keeps the lean, spec-minimal
  // shape; only the moment an item is picked up or a fact is learned gets
  // the enrichment, not every subsequent read of the inventory/knowledge.
  // Used for both walk's effects_applied and either tool's
  // arrival_effects_applied (node.knowledge_grants synthesises the same
  // add_knowledge shape on arrival).
  function enrichEffects(adventure, effects) {
    return effects.map((effect) => {
      if (effect.op === "add_item") {
        const item = adventure.itemsById.get(effect.item);
        if (!item) return effect;
        const enriched = { ...effect, name: item.name, description: item.description };
        if (item.narrative_semantics) enriched.narrative = structuredClone(item.narrative_semantics);
        return enriched;
      }
      if (effect.op === "add_knowledge") {
        const revelation = adventure.doc.semantic_layer?.knowledge_revelations?.[effect.fact];
        if (!revelation) return effect;
        // meaning is narrator subtext (foreshadowing, what the fact implies),
        // same treatment as node.narrative.hidden_truth — available to
        // inform narration, not something to state outright.
        return { ...effect, title: revelation.title, player_text: revelation.player_text, meaning: revelation.meaning };
      }
      return effect;
    });
  }

  // Content revision 0.2.5's runtime_contract: "Present the highest-
  // priority matching node.read_aloud_variant, if any." A matching variant
  // takes over read_aloud entirely for that arrival — it supersedes the
  // usual first-visit/revisit choice rather than sitting alongside it,
  // since variants are about current state truth (a licence held, a fact
  // known), not visit history.
  function selectReadAloud(node, state, isRevisit) {
    const variants = node.read_aloud_variants ?? [];
    const matching = variants
      .filter((v) => allPass(v.conditions, state))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (matching.length > 0) return matching[0].text;
    const explicit = isRevisit ? (node.read_aloud_revisit ?? node.read_aloud) : node.read_aloud;
    return explicit ?? node.narrative?.arrival_text;
  }

  function publicNode(node, state, visitCount) {
    const out = { id: node.id, title: node.title, summary: node.summary };
    const isRevisit = visitCount > 1;
    const readAloud = selectReadAloud(node, state, isRevisit);
    if (readAloud) out.read_aloud = readAloud;
    out.visit_count = visitCount;
    out.presentation = isRevisit ? "revisit" : "first_visit";
    // Always present when the node has one (content revision 0.2.5) — a
    // separate field rather than concatenated into read_aloud so the
    // narrator can judge whether it's already implied rather than
    // repeating it verbatim.
    if (node.mandatory_exposition) out.mandatory_exposition = structuredClone(node.mandatory_exposition);
    // Per-NPC rumour attribution (speaker/text/truth_status) — the same
    // kind of verified-content-safe flavour as everything else here.
    if (node.rumour_delivery) out.rumour_delivery = structuredClone(node.rumour_delivery);
    // The rest of node.narrative (local_history, present_tension,
    // hidden_truth, sensory_details, semantic_refs, narrative_hooks and
    // similar) minus arrival_text, which is already folded into read_aloud
    // above and would just be a duplicate here.
    if (node.narrative) {
      const { arrival_text, ...rest } = node.narrative;
      if (Object.keys(rest).length > 0) out.narrative = rest;
    }
    return out;
  }

  // The catalogue behind list_adventures: enough for a caller (or a player-
  // facing picker) to choose an adventure and call new_run, nothing from
  // inside any graph that the projections above wouldn't expose anyway.
  function listAdventures() {
    return {
      adventures: hosted.map((a) => ({
        adventure_id: a.id,
        title: a.doc.graph.title,
        subtitle: a.doc.graph.subtitle ?? null,
        genre: structuredClone(a.doc.graph.genre ?? []),
        tone: structuredClone(a.doc.graph.tone ?? []),
        narrative_premise: a.doc.graph.narrative_premise ?? null,
        version: a.version,
        adventure_hash: a.hash,
        node_count: a.nodesById.size,
        route_count: a.routesById.size,
        ending_count: a.terminalNodes.size,
      })),
    };
  }

  async function newRun(adventureId, label = null) {
    const adventure = adventuresById.get(adventureId);
    if (!adventure) {
      throw new EngineError(
        "unknown_adventure",
        `Unknown adventure ${adventureId}; this server hosts: ${[...adventuresById.keys()].join(", ")}.`,
        { hosted_adventures: [...adventuresById.keys()] }
      );
    }
    const runId = crypto.randomBytes(16).toString("base64url");
    const state = initialState(adventure);
    const entryNode = adventure.nodesById.get(adventure.entryNode);
    const entryVisitCount = visitNode(state, entryNode.id);
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
    const result = {
      run_id: runId,
      label: doc.label,
      adventure_id: doc.adventure_id,
      adventure_version: doc.adventure_version,
      adventure_hash: doc.adventure_hash,
      revision: 0,
      status: "active",
      node: publicNode(entryNode, state, entryVisitCount),
      state: publicState(state),
      arrival_effects_applied: enrichEffects(adventure, arrivalEffects),
    };
    // One-time scene-setting text (content revision 0.2.5), shown once at
    // the start of a run rather than repeated on every subsequent call.
    const intro = adventure.doc.graph.opening_context?.player_facing_introduction;
    if (intro) result.opening_context = intro;
    return result;
  }

  // Shared by get_node and walk's response (not by what walk persists to
  // doc.log — see the comment on walk's return below). Needs only the
  // state already held in memory, no storage read.
  function availableRoutesFor(adventure, state, status) {
    if (status !== "active") return [];
    return (adventure.routesByFrom.get(state.current_node) ?? [])
      .filter(
        (r) =>
          isVisible(r, state) &&
          isLegal(r, state) &&
          isAffordable(r, state) &&
          isNotConsumed(r, state)
      )
      .map((r) => publicRoute(adventure, r));
  }

  // Content revision 0.2.5's semantic_layer.route_resolutions[route_id]:
  // success_text always, failure_text only on routes with a test. Verified
  // safe to reveal post-hoc — where it names the failure destination, that
  // destination is already exposed by the same walk response's own
  // to/node fields, so this adds narration, not a new leak. Computed fresh
  // for the live response only, same treatment as node/route narrative
  // elsewhere — not persisted to doc.log.
  function routeResolutionText(adventure, routeId, success) {
    const resolution = adventure.doc.semantic_layer?.route_resolutions?.[routeId];
    if (!resolution) return undefined;
    return success ? resolution.success_text : resolution.failure_text;
  }

  // Strictly read-only: no mutation, no revision bump, no ETag write. Also
  // serves completed runs (with no routes) so the caller can narrate the
  // ending after the final walk.
  async function getNode(runId) {
    const { doc } = await loadRun(runId);
    const adventure = adventureForRun(doc);
    const state = doc.state;
    const node = adventure.nodesById.get(state.current_node);
    // Read-only: reports the visit count already on record rather than
    // recording one, same "no mutation" guarantee as the rest of get_node.
    // Defaults to a first visit if an older run predates visited_nodes.
    const visitCount = state.visited_nodes?.[state.current_node] ?? 1;
    return {
      run_id: doc.run_id,
      adventure_id: doc.adventure_id,
      revision: doc.revision,
      status: doc.status,
      state: publicState(state),
      node: publicNode(node, state, visitCount),
      available_routes: availableRoutesFor(adventure, state, doc.status),
    };
  }

  async function walk(runId, routeId, expectedRevision) {
    const { doc, etag } = await loadRun(runId);
    const adventure = adventureForRun(doc);
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
    const destinationVisitCount = visitNode(state, destination);
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
    // always return that unmodified. node, available_routes, the item/
    // knowledge enrichment on both effects lists and route_resolution are
    // all computed fresh from the state/asset already in memory (no extra
    // storage read) and appended only to this live response, so the common
    // case of "walk, then narrate" doesn't need a follow-up get_node round
    // trip. None of it is written to the log.
    const result = {
      ...step,
      effects_applied: enrichEffects(adventure, step.effects_applied),
      arrival_effects_applied: enrichEffects(adventure, step.arrival_effects_applied),
      node: publicNode(destinationNode, state, destinationVisitCount),
      available_routes: availableRoutesFor(adventure, state, status),
    };
    const resolutionText = routeResolutionText(adventure, route.id, success);
    if (resolutionText) result.route_resolution = resolutionText;
    return result;
  }

  // Exempt from the adventure-hash hard-stop: still returns the log, just
  // flagged, when the deployed content has moved on (or the adventure is
  // no longer hosted at all).
  async function getLog(runId) {
    const { doc } = await loadRun(runId);
    const result = {
      run_id: doc.run_id,
      adventure_id: doc.adventure_id,
      revision: doc.revision,
      status: doc.status,
      log: doc.log,
    };
    if (!adventureForRunOrNull(doc)) {
      result.adventure_mismatch = true;
      result.run_adventure_hash = doc.adventure_hash;
      result.deployed_adventure_hash = adventuresById.get(doc.adventure_id)?.hash ?? null;
    }
    return result;
  }

  return { newRun, getNode, walk, getLog, listAdventures };
}

module.exports = { createEngine };
