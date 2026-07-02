"use strict";

const { clampStat } = require("./effects");

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Ties deal no damage, so in principle a combat could roll ties forever;
// cap the loop far beyond anything reachable with honest dice.
const MAX_COMBAT_ROUNDS = 10000;

/**
 * Resolves a route's test against state, mutating state where the rules say
 * so (luck tests always cost 1 luck; combat damage lands on stamina as the
 * rounds run). Returns { resolution, success }; a route without a test is an
 * automatic success with a null resolution.
 */
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
  // Descriptive/narrative fields are static per encounter_id (already fully
  // implied by it) and small and bounded — unlike per-node/route narrative,
  // which is deliberately kept out of the persisted log for storage growth
  // reasons, this is cheap enough to persist as part of "what happened" in
  // this fight rather than recomputed each time it's read back.
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

module.exports = { resolveTest };
