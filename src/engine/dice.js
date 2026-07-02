"use strict";

const crypto = require("node:crypto");

/**
 * Returns roll(dice) -> number[]. randomInt(sides) must return an integer in
 * [0, sides) — crypto.randomInt by default; tests inject a scripted version.
 */
function makeRoller(randomInt = crypto.randomInt) {
  return function roll(dice = "2d6") {
    const [count, sides] = dice.split("d").map(Number);
    return Array.from({ length: count }, () => randomInt(sides) + 1);
  };
}

module.exports = { makeRoller };
