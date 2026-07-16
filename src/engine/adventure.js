"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { SUPPORTED_OPERATORS: CONDITION_OPS } = require("./conditions");
const { SUPPORTED_OPERATORS: EFFECT_OPS } = require("./effects");

const TEST_TYPES = new Set(["skill", "luck", "combat", "choice"]);

/**
 * Loads the static adventure asset, hashes the exact file bytes (formatting-
 * only edits intentionally invalidate existing runs), indexes nodes/routes/
 * encounters by id, and validates every reference and DSL operator. Throws
 * on any validation error so the application fails at startup, never
 * mid-game.
 */
function loadAdventure(filePath) {
  const bytes = fs.readFileSync(filePath);
  const doc = JSON.parse(bytes.toString("utf8"));
  const hash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

  const adventure = {
    doc,
    hash,
    id: doc.graph.id,
    version: doc.schema.version,
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

  const errors = validateAdventure(adventure);
  if (errors.length > 0) {
    throw new Error(`Adventure asset failed validation:\n- ${errors.join("\n- ")}`);
  }
  return adventure;
}

/**
 * Loads every adventure listed in a manifest file ({ assets: [paths] },
 * relative to the manifest's own directory). Each asset goes through the
 * same loadAdventure validation; duplicate adventure ids are a startup
 * error, since new_run dispatches on them.
 */
function loadAdventures(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error(`Adventure manifest ${manifestPath} has no assets`);
  }
  const dir = path.dirname(manifestPath);
  const adventures = manifest.assets.map((rel) => loadAdventure(path.resolve(dir, rel)));
  const seen = new Set();
  for (const adventure of adventures) {
    if (seen.has(adventure.id)) {
      throw new Error(`Adventure manifest ${manifestPath} lists duplicate adventure id ${adventure.id}`);
    }
    seen.add(adventure.id);
  }
  return adventures;
}

function validateAdventure(adventure) {
  const errors = [];
  const { doc } = adventure;
  const ps = doc.ruleset.player_state;
  const stats = new Set(Object.keys(ps.stats));
  const resources = new Set(Object.keys(ps.resources));
  const flags = ps.flags;
  const itemIds = new Set(doc.items.map((i) => i.id));

  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  if (adventure.nodesById.size !== doc.nodes.length) err("nodes", "duplicate node ids");
  if (adventure.routesById.size !== doc.routes.length) err("routes", "duplicate route ids");
  if (!adventure.nodesById.has(adventure.entryNode)) {
    err("graph.entry_node", `unknown node ${adventure.entryNode}`);
  }
  for (const t of adventure.terminalNodes) {
    if (!adventure.nodesById.has(t)) err("graph.terminal_nodes", `unknown node ${t}`);
  }
  // The death invariant hard-codes this destination.
  if (!adventure.nodesById.has("ending_dead")) err("graph", "missing ending_dead node");

  const checkConditions = (conds, where) => {
    for (const cond of conds ?? []) {
      if (Array.isArray(cond.any)) {
        checkConditions(cond.any, `${where}.any`);
        continue;
      }
      if (!CONDITION_OPS.has(cond.op)) {
        err(where, `unsupported condition operator ${cond.op}`);
        continue;
      }
      if (("stat" in cond) && !stats.has(cond.stat)) err(where, `unknown stat ${cond.stat}`);
      if (("resource" in cond) && !resources.has(cond.resource)) err(where, `unknown resource ${cond.resource}`);
      if (("item" in cond) && !itemIds.has(cond.item)) err(where, `unknown item ${cond.item}`);
      if ("flag" in cond) checkFlagValue(cond.flag, cond.value, where);
    }
  };

  const checkFlagValue = (flag, value, where) => {
    const def = flags[flag];
    if (!def) {
      err(where, `unknown flag ${flag}`);
    } else if (def.type === "enum" && !def.values.includes(value)) {
      err(where, `value ${JSON.stringify(value)} not in enum for flag ${flag}`);
    } else if (def.type === "boolean" && typeof value !== "boolean") {
      err(where, `non-boolean value for flag ${flag}`);
    }
  };

  const checkEffects = (effects, where) => {
    for (const effect of effects ?? []) {
      if (!EFFECT_OPS.has(effect.op)) {
        err(where, `unsupported effect operator ${effect.op}`);
        continue;
      }
      if (("stat" in effect) && !stats.has(effect.stat)) err(where, `unknown stat ${effect.stat}`);
      if (("resource" in effect) && !resources.has(effect.resource)) err(where, `unknown resource ${effect.resource}`);
      if (("item" in effect) && !itemIds.has(effect.item)) err(where, `unknown item ${effect.item}`);
      if (effect.op === "set_flag") checkFlagValue(effect.flag, effect.value, where);
    }
  };

  for (const node of doc.nodes) {
    if (("encounter_id" in node) && !adventure.encountersById.has(node.encounter_id)) {
      err(`node ${node.id}`, `unknown encounter ${node.encounter_id}`);
    }
    for (const variant of node.read_aloud_variants ?? []) {
      checkConditions(variant.conditions, `node ${node.id}.read_aloud_variants`);
    }
  }

  for (const route of doc.routes) {
    const where = `route ${route.id}`;
    if (!adventure.nodesById.has(route.from)) err(where, `unknown from node ${route.from}`);
    if (!adventure.nodesById.has(route.to)) err(where, `unknown to node ${route.to}`);
    checkConditions(route.conditions, where);
    checkConditions(route.visibility?.conditions, `${where}.visibility`);
    checkEffects(route.effects, where);
    for (const cost of route.costs ?? []) {
      if (!resources.has(cost.resource)) err(where, `unknown cost resource ${cost.resource}`);
    }
    if ("disclosure" in route) {
      if (!["blocked", "foreshadowed"].includes(route.disclosure)) {
        err(where, `unsupported disclosure ${JSON.stringify(route.disclosure)}`);
      }
      if (route.disclosure === "foreshadowed" && typeof route.foreshadow !== "string") {
        err(where, "disclosure \"foreshadowed\" requires a foreshadow text on the route");
      }
    }
    const test = route.test;
    if (test) {
      if (!TEST_TYPES.has(test.type)) err(where, `unsupported test type ${test.type}`);
      if (!adventure.nodesById.has(test.failure_to)) {
        err(where, `unknown failure_to node ${test.failure_to}`);
      }
      if (test.type === "combat") {
        if (!adventure.encountersById.has(test.encounter_id)) {
          err(where, `unknown encounter ${test.encounter_id}`);
        }
      } else if (!stats.has(test.stat)) {
        err(where, `unknown test stat ${test.stat}`);
      }
      checkEffects(test.failure_effects, `${where}.failure_effects`);
      if ("effects" in test) err(where, "test.effects is not supported; use failure_effects");
    }
  }

  // Ending assertions: an ending's narration often asserts state ("she
  // goes home with her name"), and nothing used to check that the terminal
  // state actually agrees. validation.ending_assertions[node_id] lists
  // flag/value pairs the ending's prose relies on; every routed way into
  // that ending must guarantee each one — by setting the flag itself, by
  // requiring it as a condition, or by requiring an item whose every
  // granting route sets the flag alongside it (the witness trace:
  // requiring sisters_true_name proves name_recovered when every route
  // that grants the item also sets the flag). This is a one-level static
  // check: it can't see a later route un-setting the flag, so keep
  // asserted flags monotonic. Don't assert on ending_dead — the stamina
  // death invariant routes there from anywhere, bypassing this analysis.
  const setsFlag = (effects, flag, value) =>
    (effects ?? []).some((e) => e.op === "set_flag" && e.flag === flag && e.value === value);
  const requiresFlag = (conds, flag, value) =>
    (conds ?? []).some((c) => c.op === "flag_is" && c.flag === flag && c.value === value);
  const itemGuaranteesFlag = (item, flag, value) => {
    if ((ps.collections.inventory.initial ?? []).includes(item)) return false;
    const grantingLists = [];
    for (const r of doc.routes) {
      if ((r.effects ?? []).some((e) => e.op === "add_item" && e.item === item)) {
        grantingLists.push(r.effects);
      }
      if ((r.test?.failure_effects ?? []).some((e) => e.op === "add_item" && e.item === item)) {
        grantingLists.push(r.test.failure_effects);
      }
    }
    return grantingLists.length > 0 && grantingLists.every((list) => setsFlag(list, flag, value));
  };
  for (const [endingId, asserts] of Object.entries(doc.validation?.ending_assertions ?? {})) {
    const where = `validation.ending_assertions.${endingId}`;
    if (!adventure.nodesById.has(endingId)) {
      err(where, `unknown node ${endingId}`);
      continue;
    }
    if (endingId === "ending_dead") {
      err(where, "assertions on ending_dead are unsound (the death invariant bypasses routes)");
      continue;
    }
    for (const assertion of asserts) {
      checkFlagValue(assertion.flag, assertion.value, where);
      for (const r of doc.routes) {
        const arrivals = [];
        if (r.to === endingId) arrivals.push(r.effects);
        if (r.test?.failure_to === endingId) arrivals.push(r.test.failure_effects);
        // Visibility conditions gate walk just as hard as legality
        // conditions, so either list can guarantee an assertion.
        const gates = [...(r.conditions ?? []), ...(r.visibility?.conditions ?? [])];
        for (const effects of arrivals) {
          const guaranteed =
            setsFlag(effects, assertion.flag, assertion.value) ||
            requiresFlag(gates, assertion.flag, assertion.value) ||
            gates.some(
              (c) => c.op === "has_item" && itemGuaranteesFlag(c.item, assertion.flag, assertion.value)
            );
          if (!guaranteed) {
            err(
              `route ${r.id}`,
              `reaches ${endingId} without guaranteeing ${assertion.flag} = ${JSON.stringify(assertion.value)} (${where})`
            );
          }
        }
      }
    }
  }

  return errors;
}

/** Fresh player state seeded from the ruleset's "initial" values. */
function initialState(adventure) {
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
    // Engine-tracked bookkeeping, same as consumed_routes: not part of any
    // adventure-authored ruleset schema, incremented on every arrival at a
    // node so the engine — not the caller's memory of the conversation —
    // can decide first-visit vs revisit presentation.
    visited_nodes: {},
  };
}

module.exports = { loadAdventure, loadAdventures, validateAdventure, initialState };
