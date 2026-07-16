// Browser port of the Rust Wind Hills game engine (src/engine/*), as one
// dependency-free ES module. Same rules, same projections, same DSL — but
// synchronous and storage-free: the run document lives in memory (the web
// app persists it to localStorage between visits) instead of a blob store,
// so there are no ETags, no expected_revision argument and no async. The
// mechanical semantics — costs spent on the attempt, test.stat read rather
// than inferred, luck tests always costing 1 luck, the death invariant,
// stat clamping, one_time route consumption, the four availability checks —
// are ported verbatim from src/engine and kept honest by
// test/web-engine.test.js, which drives this module with scripted dice.

const RUN_SCHEMA_VERSION = "1.0";

export class EngineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------- dice ----

// randomInt(sides) -> integer in [0, sides), unbiased via rejection
// sampling. globalThis.crypto exists in every browser and in Node >= 19.
export function defaultRandomInt(sides) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % sides;
}

export function makeRoller(randomInt = defaultRandomInt) {
  return function roll(dice = "2d6") {
    const [count, sides] = dice.split("d").map(Number);
    return Array.from({ length: count }, () => randomInt(sides) + 1);
  };
}

function randomId(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------- conditions ----

export function evalCondition(cond, state) {
  if (Array.isArray(cond.any)) {
    return cond.any.some((c) => evalCondition(c, state));
  }
  switch (cond.op) {
    case "has_item":
      return state.inventory.includes(cond.item);
    case "missing_item":
      return !state.inventory.includes(cond.item);
    case "flag_is":
      return state.flags[cond.flag] === cond.value;
    case "flag_not":
      return state.flags[cond.flag] !== cond.value;
    case "stat_at_least":
      return state.stats[cond.stat] >= cond.value;
    case "stat_below":
      return state.stats[cond.stat] < cond.value;
    case "resource_at_least":
      return state.resources[cond.resource] >= cond.value;
    case "resource_below":
      return state.resources[cond.resource] < cond.value;
    case "has_condition":
      return state.conditions.includes(cond.condition);
    case "missing_condition":
      return !state.conditions.includes(cond.condition);
    case "knows":
      return state.knowledge.includes(cond.fact);
    case "not_knows":
      return !state.knowledge.includes(cond.fact);
    default:
      throw new Error(`Unsupported condition operator: ${cond.op}`);
  }
}

export function allPass(conditions, state) {
  return (conditions ?? []).every((c) => evalCondition(c, state));
}

// ------------------------------------------------------------- effects ----

function clampStat(adventure, name, value) {
  const def = adventure.doc.ruleset.player_state.stats[name];
  let v = value;
  if (typeof def.min === "number") v = Math.max(def.min, v);
  if (typeof def.max === "number") v = Math.min(def.max, v);
  return v;
}

function applyEffect(effect, state, adventure) {
  switch (effect.op) {
    case "add_item":
      if (!state.inventory.includes(effect.item)) state.inventory.push(effect.item);
      break;
    case "remove_item":
      state.inventory = state.inventory.filter((i) => i !== effect.item);
      break;
    case "set_flag":
      state.flags[effect.flag] = effect.value;
      break;
    case "modify_stat":
      state.stats[effect.stat] = clampStat(
        adventure,
        effect.stat,
        state.stats[effect.stat] + effect.amount
      );
      break;
    case "modify_resource":
      state.resources[effect.resource] = Math.max(
        0,
        state.resources[effect.resource] + effect.amount
      );
      break;
    case "add_condition":
      if (!state.conditions.includes(effect.condition)) state.conditions.push(effect.condition);
      break;
    case "remove_condition":
      state.conditions = state.conditions.filter((c) => c !== effect.condition);
      break;
    case "add_knowledge":
      if (!state.knowledge.includes(effect.fact)) state.knowledge.push(effect.fact);
      break;
    case "emit_event":
      break;
    default:
      throw new Error(`Unsupported effect operator: ${effect.op}`);
  }
}

function applyEffects(effects, state, adventure) {
  const applied = [];
  for (const effect of effects ?? []) {
    applyEffect(effect, state, adventure);
    applied.push(structuredClone(effect));
  }
  return applied;
}

function applyKnowledgeGrants(node, state) {
  const applied = [];
  for (const fact of node.knowledge_grants ?? []) {
    if (!state.knowledge.includes(fact)) {
      state.knowledge.push(fact);
      applied.push({ op: "add_knowledge", fact, source: node.id });
    }
  }
  return applied;
}

// ------------------------------------------------------------- resolve ----

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const MAX_COMBAT_ROUNDS = 10000;

function resolveTest(test, state, adventure, roll) {
  if (!test) return { resolution: null, success: true };
  if (test.type === "combat") return resolveCombat(test, state, adventure, roll);

  // Read test.stat, never infer it from test.type — r063 is typed "skill"
  // but tests luck.
  const stat = test.stat;
  const modifier = test.modifier ?? 0;
  const rolls = roll("2d6");
  const total = sum(rolls);
  const target = state.stats[stat] + modifier;
  const success = total <= target;
  if (stat === "luck") {
    state.stats.luck = clampStat(adventure, "luck", state.stats.luck - 1);
  }
  return { resolution: { type: test.type, rolls, total, target, success }, success };
}

function resolveCombat(test, state, adventure, roll) {
  const encounter = adventure.encountersById.get(test.encounter_id);
  let enemyStamina = encounter.stamina;
  const rounds = [];
  while (state.stats.stamina > 0 && enemyStamina > 0) {
    if (rounds.length >= MAX_COMBAT_ROUNDS) {
      throw new Error(`Combat against ${test.encounter_id} exceeded ${MAX_COMBAT_ROUNDS} rounds`);
    }
    const playerRolls = roll("2d6");
    const enemyRolls = roll("2d6");
    const playerAttack = state.stats.skill + sum(playerRolls);
    const enemyAttack = encounter.skill + sum(enemyRolls);
    let damageTo = null;
    let damage = 0;
    if (playerAttack > enemyAttack) {
      damageTo = "enemy";
      damage = 2;
      enemyStamina = Math.max(0, enemyStamina - 2);
    } else if (enemyAttack > playerAttack) {
      damageTo = "player";
      damage = 2;
      state.stats.stamina = clampStat(adventure, "stamina", state.stats.stamina - 2);
    }
    rounds.push({
      player_rolls: playerRolls,
      enemy_rolls: enemyRolls,
      player_attack: playerAttack,
      enemy_attack: enemyAttack,
      damage_to: damageTo,
      damage,
      player_stamina_after: state.stats.stamina,
      enemy_stamina_after: enemyStamina,
    });
  }
  const success = state.stats.stamina > 0;
  const resolution = {
    type: "combat",
    encounter_id: test.encounter_id,
    encounter_name: encounter.name,
    encounter_kind: encounter.kind,
    special: encounter.special,
    success,
    rounds,
  };
  if (encounter.narrative_semantics) resolution.narrative = structuredClone(encounter.narrative_semantics);
  return { resolution, success };
}

// ----------------------------------------------------------- adventure ----

// Indexes an already-parsed adventure document (the browser fetches the
// JSON itself; there is no fs here, and no byte hashing since a local run
// never has to survive a redeploy of different content).
export function indexAdventure(doc) {
  const adventure = {
    doc,
    id: doc.graph.id,
    version: doc.schema.version,
    title: doc.graph.title,
    subtitle: doc.graph.subtitle,
    entryNode: doc.graph.entry_node,
    terminalNodes: new Set(doc.graph.terminal_nodes),
    nodesById: new Map(doc.nodes.map((n) => [n.id, n])),
    routesById: new Map(doc.routes.map((r) => [r.id, r])),
    routesByFrom: new Map(),
    encountersById: new Map(doc.encounters.map((e) => [e.id, e])),
    itemsById: new Map(doc.items.map((i) => [i.id, i])),
  };
  for (const route of doc.routes) {
    if (!adventure.routesByFrom.has(route.from)) adventure.routesByFrom.set(route.from, []);
    adventure.routesByFrom.get(route.from).push(route);
  }
  return adventure;
}

export function initialState(adventure) {
  const ps = adventure.doc.ruleset.player_state;
  const pick = (defs) =>
    Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, def.initial]));
  return {
    current_node: adventure.entryNode,
    stats: pick(ps.stats),
    resources: pick(ps.resources),
    inventory: [...ps.collections.inventory.initial],
    conditions: [...ps.collections.conditions.initial],
    knowledge: [...ps.collections.knowledge.initial],
    consumed_routes: [],
    flags: pick(ps.flags),
    visited_nodes: {},
  };
}

// --------------------------------------------------------- projections ----

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

// Same content-safety rules as the server: never expose failure_to,
// failure_effects or visibility details; drop narrative.content_role.
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
  if (route.stakes) out.stakes = route.stakes;
  if (route.hook) out.hook = route.hook;
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

function visitNode(state, nodeId) {
  state.visited_nodes ??= {};
  state.visited_nodes[nodeId] = (state.visited_nodes[nodeId] ?? 0) + 1;
  return state.visited_nodes[nodeId];
}

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
      return { ...effect, title: revelation.title, player_text: revelation.player_text, meaning: revelation.meaning };
    }
    return effect;
  });
}

// A matching condition-gated variant beats the first-visit/revisit choice:
// variants are about current state truth, not visit history.
function selectReadAloud(node, state, isRevisit) {
  const variants = node.read_aloud_variants ?? [];
  const matching = variants
    .filter((v) => allPass(v.conditions, state))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (matching.length > 0) return matching[0].text;
  const explicit = isRevisit ? (node.read_aloud_revisit ?? node.read_aloud) : node.read_aloud;
  return explicit ?? node.narrative?.arrival_text;
}

function publicNode(adventure, node, state, visitCount) {
  const out = { id: node.id, title: node.title, summary: node.summary };
  const isRevisit = visitCount > 1;
  const readAloud = selectReadAloud(node, state, isRevisit);
  if (readAloud) out.read_aloud = readAloud;
  out.visit_count = visitCount;
  out.presentation = isRevisit ? "revisit" : "first_visit";
  if (node.mandatory_exposition) out.mandatory_exposition = structuredClone(node.mandatory_exposition);
  if (node.rumour_delivery) out.rumour_delivery = structuredClone(node.rumour_delivery);
  if (node.narrative) {
    const { arrival_text, ...rest } = node.narrative;
    if (Object.keys(rest).length > 0) out.narrative = rest;
  }
  return out;
}

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

function routeResolutionText(adventure, routeId, success) {
  const resolution = adventure.doc.semantic_layer?.route_resolutions?.[routeId];
  if (!resolution) return undefined;
  return success ? resolution.success_text : resolution.failure_text;
}

// Controlled visibility for gated routes — ported verbatim from
// src/engine/engine.js. A route declaring disclosure "blocked" is surfaced
// with its exact unmet requirements; "foreshadowed" with only its authored
// foreshadow hint. Routes without disclosure stay hidden, and routes gated
// by visibility conditions or already consumed are never surfaced.
function describeCondition(cond, adventure) {
  if (Array.isArray(cond.any)) {
    return `any of: ${cond.any.map((c) => describeCondition(c, adventure)).join("; ")}`;
  }
  switch (cond.op) {
    case "has_item":
      return `requires ${adventure.itemsById.get(cond.item)?.name ?? cond.item}`;
    case "missing_item":
      return `requires not carrying ${adventure.itemsById.get(cond.item)?.name ?? cond.item}`;
    case "knows": {
      const title = adventure.doc.semantic_layer?.knowledge_revelations?.[cond.fact]?.title;
      return `requires knowing: ${title ?? cond.fact}`;
    }
    case "not_knows": {
      const title = adventure.doc.semantic_layer?.knowledge_revelations?.[cond.fact]?.title;
      return `requires not yet knowing: ${title ?? cond.fact}`;
    }
    case "flag_is":
      return `requires ${cond.flag} to be ${cond.value}`;
    case "flag_not":
      return `requires ${cond.flag} not to be ${cond.value}`;
    case "stat_at_least":
      return `requires ${cond.stat} of at least ${cond.value}`;
    case "stat_below":
      return `requires ${cond.stat} below ${cond.value}`;
    case "resource_at_least":
      return `requires at least ${cond.value} ${cond.resource}`;
    case "resource_below":
      return `requires ${cond.resource} below ${cond.value}`;
    case "has_condition":
      return `requires the ${cond.condition} condition`;
    case "missing_condition":
      return `requires being free of the ${cond.condition} condition`;
    default:
      return "requires something unmet";
  }
}

function blockedRoutesFor(adventure, state, status) {
  if (status !== "active") return [];
  const out = [];
  for (const route of adventure.routesByFrom.get(state.current_node) ?? []) {
    if (!route.disclosure) continue;
    if (!isVisible(route, state) || !isNotConsumed(route, state)) continue;
    const legal = isLegal(route, state);
    const affordable = isAffordable(route, state);
    if (legal && affordable) continue; // available — listed normally instead
    if (route.disclosure === "foreshadowed") {
      out.push({ label: route.label, disclosure: "foreshadowed", hint: route.foreshadow });
      continue;
    }
    const reasons = [];
    if (!legal) {
      for (const cond of route.conditions ?? []) {
        if (!evalCondition(cond, state)) reasons.push(describeCondition(cond, adventure));
      }
    }
    for (const cost of route.costs ?? []) {
      if (state.resources[cost.resource] < cost.amount) {
        reasons.push(
          `requires ${cost.amount} ${cost.resource} (you have ${state.resources[cost.resource]})`
        );
      }
    }
    out.push({ label: route.label, disclosure: "blocked", reason: reasons.join("; ") });
  }
  return out;
}

// ---------------------------------------------------------------- runs ----

/** Starts a run. Returns { doc, result }; doc is what the app persists. */
export function newRun(adventure, { label = null, randomInt, now = () => new Date().toISOString() } = {}) {
  const runId = randomId(16);
  const state = initialState(adventure);
  const entryNode = adventure.nodesById.get(adventure.entryNode);
  const entryVisitCount = visitNode(state, entryNode.id);
  const arrivalEffects = applyKnowledgeGrants(entryNode, state);
  const timestamp = now();
  const doc = {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: runId,
    label,
    adventure_id: adventure.id,
    adventure_version: adventure.version,
    revision: 0,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
    state,
    log: [],
  };
  const result = {
    run_id: runId,
    status: "active",
    node: publicNode(adventure, entryNode, state, entryVisitCount),
    state: publicState(state),
    arrival_effects_applied: enrichEffects(adventure, arrivalEffects),
    available_routes: availableRoutesFor(adventure, state, "active"),
  };
  const entryBlocked = blockedRoutesFor(adventure, state, "active");
  if (entryBlocked.length > 0) result.blocked_routes = entryBlocked;
  const intro = adventure.doc.graph.opening_context?.player_facing_introduction;
  if (intro) result.opening_context = intro;
  return { doc, result };
}

/** Read-only view of a run's current node, state and open routes. */
export function getNode(adventure, doc) {
  if (doc.adventure_id !== adventure.id || doc.adventure_version !== adventure.version) {
    throw new EngineError(
      "adventure_mismatch",
      "This run was created against a different version of the adventure content."
    );
  }
  const state = doc.state;
  const node = adventure.nodesById.get(state.current_node);
  const visitCount = state.visited_nodes?.[state.current_node] ?? 1;
  const result = {
    run_id: doc.run_id,
    revision: doc.revision,
    status: doc.status,
    state: publicState(state),
    node: publicNode(adventure, node, state, visitCount),
    available_routes: availableRoutesFor(adventure, state, doc.status),
  };
  const blocked = blockedRoutesFor(adventure, state, doc.status);
  if (blocked.length > 0) result.blocked_routes = blocked;
  return result;
}

/** Takes a route. Mutates doc (state, log, revision) and returns the step. */
export function walk(adventure, doc, routeId, { randomInt, now = () => new Date().toISOString() } = {}) {
  if (doc.adventure_id !== adventure.id || doc.adventure_version !== adventure.version) {
    throw new EngineError(
      "adventure_mismatch",
      "This run was created against a different version of the adventure content."
    );
  }
  if (doc.status !== "active") {
    throw new EngineError("run_not_active", `Run ${doc.run_id} is ${doc.status}.`);
  }
  const roll = makeRoller(randomInt);

  // Any failure collapses into the same generic error so the response never
  // distinguishes unknown / wrong-node / hidden / illegal / consumed /
  // unaffordable — same secrecy contract as the server.
  const state = doc.state;
  const route = adventure.routesById.get(routeId);
  const available =
    route &&
    route.from === state.current_node &&
    isVisible(route, state) &&
    isLegal(route, state) &&
    isNotConsumed(route, state) &&
    isAffordable(route, state);
  if (!available) {
    throw new EngineError("route_unavailable", "That route is not available from here.");
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
    step_id: randomId(6),
    revision_before: doc.revision - 1,
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

  const result = {
    ...step,
    // status_after is the persisted-log name; the live response also says
    // status so it reads uniformly with newRun/getNode views.
    status,
    route_label: route.label,
    effects_applied: enrichEffects(adventure, step.effects_applied),
    arrival_effects_applied: enrichEffects(adventure, step.arrival_effects_applied),
    node: publicNode(adventure, destinationNode, state, destinationVisitCount),
    available_routes: availableRoutesFor(adventure, state, status),
    state: publicState(state),
  };
  const blocked = blockedRoutesFor(adventure, state, status);
  if (blocked.length > 0) result.blocked_routes = blocked;
  const resolutionText = routeResolutionText(adventure, route.id, success);
  if (resolutionText) result.route_resolution = resolutionText;
  return result;
}
