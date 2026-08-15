/** Cryptographically-random die roll, 1..6. */
export function rollD6() {
  return 1 + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * 6);
}

/** Rolls `count` d6 and returns { dice: number[], total: number }. */
export function rollDice(count = 2) {
  const dice = Array.from({ length: count }, rollD6);
  return { dice, total: dice.reduce((sum, d) => sum + d, 0) };
}

let logSeq = 0;
export function nextLogId() {
  logSeq += 1;
  return `${Date.now()}-${logSeq}`;
}
