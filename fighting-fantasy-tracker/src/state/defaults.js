// Data model mirrors the brief's TypeScript interfaces exactly, expressed
// as plain JS factories (no TS build step needed for a project this small).
//
// interface SectionNode { id, title?, visited, notes?, choices: Choice[] }
// interface Choice { targetId, label, condition? }
// interface CharacterSheet { skill, stamina, luck: {current, initial}, inventory, gold, provisions }
// interface GameState { bookTitle, character, currentSectionId, history, nodes, combatLog }

export function rollDie() {
  return 1 + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * 6);
}

export function newCharacterSheet() {
  // Standard Fighting Fantasy character generation.
  const skill = rollDie() + 6;
  const stamina = rollDie() + rollDie() + 12;
  const luck = rollDie() + 6;
  return {
    skill: { current: skill, initial: skill },
    stamina: { current: stamina, initial: stamina },
    luck: { current: luck, initial: luck },
    inventory: [],
    gold: 0,
    provisions: 0,
  };
}

export function blankSectionNode(id) {
  return {
    id,
    title: '',
    visited: true,
    notes: '',
    choices: [],
  };
}

export function newGameState(bookTitle = 'Untitled Adventure') {
  const startId = 1;
  return {
    bookTitle,
    character: newCharacterSheet(),
    currentSectionId: startId,
    history: [startId],
    nodes: { [startId]: blankSectionNode(startId) },
    combatLog: [],
    enemies: [],
    currentEnemyIndex: 0,
  };
}

export function cloneState(state) {
  return structuredClone(state);
}
