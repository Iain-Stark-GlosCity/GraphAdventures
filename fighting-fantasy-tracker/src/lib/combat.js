import { rollDice } from './dice.js';

const BASE_DAMAGE = 2;

/**
 * One Fighting Fantasy attack round: 2d6+SKILL for each side, higher
 * Attack Strength wins, loser takes 2 STAMINA damage. Equal strengths
 * hit nobody.
 */
export function resolveAttackRound(playerSkill, enemySkill) {
  const playerRoll = rollDice(2);
  const enemyRoll = rollDice(2);
  const playerStrength = playerRoll.total + playerSkill;
  const enemyStrength = enemyRoll.total + enemySkill;

  let outcome = 'draw';
  if (playerStrength > enemyStrength) outcome = 'player_hits';
  else if (enemyStrength > playerStrength) outcome = 'enemy_hits';

  return {
    playerRoll,
    enemyRoll,
    playerStrength,
    enemyStrength,
    outcome,
    damage: outcome === 'draw' ? 0 : BASE_DAMAGE,
  };
}

/**
 * Test Your Luck: roll 2d6, success if the total is <= current luck.
 * Testing luck always costs 1 point of current luck, win or lose.
 */
export function testLuck(currentLuck) {
  const roll = rollDice(2);
  const lucky = roll.total <= currentLuck;
  return { roll, lucky, newLuck: Math.max(0, currentLuck - 1) };
}

/**
 * Applies a Test Your Luck result to a just-resolved combat hit.
 * `beneficiary` is 'player' (player wounded the enemy) or 'enemy'
 * (enemy wounded the player) — i.e. who landed the hit this round.
 * Lucky: the winner presses the advantage (+2 extra damage), or the
 * loser shrugs off some of the blow (-1 damage). Unlucky: the reverse.
 */
export function applyLuckToDamage(baseDamage, beneficiary, lucky) {
  if (beneficiary === 'player') {
    // Player wounded the enemy; luck affects enemy's stamina loss.
    return lucky ? baseDamage + 2 : Math.max(1, baseDamage - 1);
  }
  // Enemy wounded the player; luck affects player's stamina loss.
  return lucky ? Math.max(1, baseDamage - 1) : baseDamage + 1;
}
