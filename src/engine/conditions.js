"use strict";

const SUPPORTED_OPERATORS = new Set([
  "has_item",
  "missing_item",
  "flag_is",
  "flag_not",
  "stat_at_least",
  "stat_below",
  "resource_at_least",
  "has_condition",
  "missing_condition",
  "knows",
  "not_knows",
]);

function evalCondition(cond, state) {
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

/** All conditions must pass; an explicit { any: [...] } block is an OR. */
function allPass(conditions, state) {
  return (conditions ?? []).every((c) => evalCondition(c, state));
}

module.exports = { SUPPORTED_OPERATORS, evalCondition, allPass };
