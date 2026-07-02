"use strict";

const SUPPORTED_OPERATORS = new Set([
  "add_item",
  "remove_item",
  "set_flag",
  "modify_stat",
  "modify_resource",
  "add_condition",
  "remove_condition",
  "add_knowledge",
  "emit_event",
]);

function clampStat(adventure, name, value) {
  const def = adventure.doc.ruleset.player_state.stats[name];
  let v = value;
  if (typeof def.min === "number") v = Math.max(def.min, v);
  if (typeof def.max === "number") v = Math.min(def.max, v);
  return v;
}

/**
 * Applies one effect to state in place. Item/condition/knowledge adds and
 * removes are idempotent no-ops when the entry is already present/absent;
 * stats clamp to their declared min/max and resources never go below zero.
 */
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
      // No state change; the effect record in the log is the event.
      break;
    default:
      throw new Error(`Unsupported effect operator: ${effect.op}`);
  }
}

/** Applies a list of effects, returning the records for the step log. */
function applyEffects(effects, state, adventure) {
  const applied = [];
  for (const effect of effects ?? []) {
    applyEffect(effect, state, adventure);
    applied.push(structuredClone(effect));
  }
  return applied;
}

/**
 * knowledge_grants on a node is an array of bare fact strings, not effect
 * objects. Convert each newly learned fact into a synthetic add_knowledge
 * record for arrival_effects_applied.
 */
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

module.exports = {
  SUPPORTED_OPERATORS,
  clampStat,
  applyEffect,
  applyEffects,
  applyKnowledgeGrants,
};
