import { h, mount, clear } from '../lib/dom.js';
import { rollDice, nextLogId } from '../lib/dice.js';
import { resolveAttackRound, testLuck, applyLuckToDamage } from '../lib/combat.js';
import { clamp, formatTime } from '../lib/format.js';

// Plain in-memory log of general dice rolls — the brief scopes IndexedDB
// persistence to GameState (character/combat/sections); a quick d6/2d6
// scratch roll for random table lookups etc. doesn't need to survive reload.
let quickRollLog = [];
let diceCount = 2;
let pendingLuckRoundId = null;

function pushCombatLog(state, entry) {
  state.combatLog.unshift({ id: nextLogId(), timestamp: Date.now(), ...entry });
  state.combatLog = state.combatLog.slice(0, 50);
}

export function renderDiceCombat(container, ctx) {
  const { state, update } = ctx;
  clear(container);

  container.appendChild(renderQuickRoller());
  container.appendChild(renderLuckTester(state, update));
  container.appendChild(renderCombatTracker(state, update));
}

function renderQuickRoller() {
  const resultEl = h('div', { class: 'dice-result', 'aria-live': 'polite' }, 'Tap to roll');
  const logEl = h('ul', { class: 'roll-log' });

  function renderLog() {
    clear(logEl);
    for (const entry of quickRollLog.slice(0, 10)) {
      logEl.appendChild(
        h(
          'li',
          {},
          h('span', { class: 'roll-log-dice' }, entry.dice.join(' + ')),
          h('span', { class: 'roll-log-total' }, `= ${entry.total}`)
        )
      );
    }
  }

  function doRoll() {
    const result = rollDice(diceCount);
    quickRollLog = [{ ...result, at: Date.now() }, ...quickRollLog].slice(0, 10);
    clear(resultEl);
    resultEl.appendChild(
      h(
        'div',
        { class: 'dice-result-value' },
        h('span', { class: 'dice-pips' }, result.dice.map((d) => h('span', { class: 'die' }, d))),
        h('span', { class: 'dice-total' }, `${result.total}`)
      )
    );
    renderLog();
  }

  const toggle = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Number of dice' },
    h(
      'button',
      {
        class: diceCount === 1 ? 'segmented-btn active' : 'segmented-btn',
        onClick: () => {
          diceCount = 1;
          toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          toggle.firstChild.classList.add('active');
        },
      },
      '1 die'
    ),
    h(
      'button',
      {
        class: diceCount === 2 ? 'segmented-btn active' : 'segmented-btn',
        onClick: () => {
          diceCount = 2;
          toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          toggle.lastChild.classList.add('active');
        },
      },
      '2 dice'
    )
  );

  renderLog();

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Dice Roller'),
    toggle,
    h('button', { class: 'big-roll-btn', onClick: doRoll }, 'Roll'),
    resultEl,
    logEl.children.length ? h('h3', { class: 'sublabel' }, 'Recent rolls') : null,
    logEl
  );
}

function renderLuckTester(state, update) {
  const luck = state.character.luck.current;
  const disabled = luck <= 0;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Test Your Luck'),
    h('p', { class: 'hint' }, `Current LUCK: ${luck}. Rolls 2d6 against LUCK, then LUCK drops by 1 either way.`),
    h(
      'button',
      {
        class: 'secondary-btn',
        disabled,
        onClick: () => {
          const { roll, lucky, newLuck } = testLuck(luck);
          state.character.luck.current = newLuck;
          pushCombatLog(state, {
            type: 'luck_test',
            message: `Tested Luck: rolled ${roll.total} (${roll.dice.join('+')}) — ${lucky ? 'Lucky!' : 'Unlucky!'} LUCK now ${newLuck}.`,
          });
          update();
        },
      },
      disabled ? 'No Luck left' : 'Test Your Luck'
    )
  );
}

function renderCombatTracker(state, update) {
  const section = h('section', { class: 'card combat-card' }, h('h2', {}, 'Combat Tracker'));

  section.appendChild(renderAddEnemyForm(state, update));

  if (state.enemies.length === 0) {
    section.appendChild(h('p', { class: 'hint' }, 'No enemies yet. Add one above to start a fight.'));
  } else {
    section.appendChild(renderEnemyList(state, update));
    section.appendChild(renderPlayerStaminaRow(state));
    section.appendChild(renderCombatControls(state, update));
  }

  section.appendChild(renderCombatLog(state));

  return section;
}

function renderAddEnemyForm(state, update) {
  const nameInput = h('input', { type: 'text', placeholder: 'Enemy name', class: 'text-input' });
  const skillInput = h('input', { type: 'number', placeholder: 'SKILL', class: 'num-input', inputmode: 'numeric' });
  const staminaInput = h('input', { type: 'number', placeholder: 'STAMINA', class: 'num-input', inputmode: 'numeric' });

  function addEnemy() {
    const name = nameInput.value.trim() || `Enemy ${state.enemies.length + 1}`;
    const skill = Number(skillInput.value) || 0;
    const stamina = Number(staminaInput.value) || 0;
    if (skill <= 0 || stamina <= 0) return;
    state.enemies.push({ id: nextLogId(), name, skill, stamina, initialStamina: stamina, defeated: false });
    pushCombatLog(state, { type: 'enemy_added', message: `${name} appeared (SKILL ${skill}, STAMINA ${stamina}).` });
    nameInput.value = '';
    skillInput.value = '';
    staminaInput.value = '';
    update();
  }

  return h(
    'form',
    {
      class: 'add-enemy-form',
      onSubmit: (e) => {
        e.preventDefault();
        addEnemy();
      },
    },
    nameInput,
    skillInput,
    staminaInput,
    h('button', { type: 'submit', class: 'secondary-btn' }, 'Add Enemy')
  );
}

function renderEnemyList(state, update) {
  const currentEnemy = getCurrentEnemy(state);
  return h(
    'ul',
    { class: 'enemy-list' },
    state.enemies.map((enemy) => {
      const pct = clamp((enemy.stamina / enemy.initialStamina) * 100, 0, 100);
      const isCurrent = currentEnemy && enemy.id === currentEnemy.id;
      return h(
        'li',
        { class: `enemy-row${isCurrent ? ' current' : ''}${enemy.defeated ? ' defeated' : ''}` },
        h('div', { class: 'enemy-name-row' },
          h('span', { class: 'enemy-name' }, enemy.name),
          h('span', { class: 'enemy-skill' }, `SKILL ${enemy.skill}`),
          h('button', {
            class: 'icon-btn',
            'aria-label': `Remove ${enemy.name}`,
            onClick: () => {
              state.enemies = state.enemies.filter((e) => e.id !== enemy.id);
              normalizeCurrentEnemyIndex(state);
              update();
            },
          }, '✕')
        ),
        h('div', { class: 'stamina-bar-track' },
          h('div', { class: 'stamina-bar-fill', style: `width:${pct}%` })
        ),
        h('div', { class: 'stamina-label' }, `${Math.max(0, enemy.stamina)} / ${enemy.initialStamina} STAMINA`)
      );
    })
  );
}

function renderPlayerStaminaRow(state) {
  const c = state.character;
  const pct = clamp((c.stamina.current / c.stamina.initial) * 100, 0, 100);
  return h(
    'div',
    { class: 'player-stamina-row' },
    h('div', { class: 'enemy-name-row' },
      h('span', { class: 'enemy-name' }, 'You'),
      h('span', { class: 'enemy-skill' }, `SKILL ${c.skill.current}`)
    ),
    h('div', { class: 'stamina-bar-track' },
      h('div', { class: `stamina-bar-fill${c.stamina.current <= 0 ? ' danger' : ''}`, style: `width:${pct}%` })
    ),
    h('div', { class: 'stamina-label' }, `${Math.max(0, c.stamina.current)} / ${c.stamina.initial} STAMINA`)
  );
}

function getCurrentEnemy(state) {
  return state.enemies.find((e) => !e.defeated) ?? null;
}

function normalizeCurrentEnemyIndex(state) {
  const idx = state.enemies.findIndex((e) => !e.defeated);
  state.currentEnemyIndex = idx === -1 ? 0 : idx;
}

function renderCombatControls(state, update) {
  const currentEnemy = getCurrentEnemy(state);
  const playerDefeated = state.character.stamina.current <= 0;

  if (!currentEnemy) {
    return h(
      'div',
      { class: 'combat-controls' },
      h('p', { class: 'victory-banner' }, 'All enemies defeated — Victory!'),
      h('button', { class: 'secondary-btn', onClick: () => { clearCombat(state); update(); } }, 'Clear Combat')
    );
  }

  if (playerDefeated) {
    return h(
      'div',
      { class: 'combat-controls' },
      h('p', { class: 'danger-banner' }, 'STAMINA at 0 — restore on the Character tab before continuing.'),
      h('button', { class: 'secondary-btn', onClick: () => { clearCombat(state); update(); } }, 'End Combat')
    );
  }

  const canTestLuck = pendingLuckRoundId != null;

  return h(
    'div',
    { class: 'combat-controls' },
    h(
      'button',
      { class: 'big-roll-btn', onClick: () => runAttackRound(state, currentEnemy, update) },
      `Attack Round vs ${currentEnemy.name}`
    ),
    h(
      'button',
      {
        class: 'secondary-btn',
        disabled: !canTestLuck || state.character.luck.current <= 0,
        onClick: () => applyPendingLuck(state, update),
      },
      'Test Luck on Last Round'
    ),
    h('button', { class: 'text-btn', onClick: () => { clearCombat(state); update(); } }, 'Flee / End Combat')
  );
}

function runAttackRound(state, enemy, update) {
  const round = resolveAttackRound(state.character.skill.current, enemy.skill);
  const roundId = nextLogId();

  if (round.outcome === 'player_hits') {
    enemy.stamina -= round.damage;
    if (enemy.stamina <= 0) {
      enemy.defeated = true;
      normalizeCurrentEnemyIndex(state);
    }
    pushCombatLog(state, {
      type: 'attack_round',
      roundId,
      side: 'player',
      message: `You ${round.playerStrength} vs ${enemy.name} ${round.enemyStrength} — you hit for ${round.damage}. ${enemy.defeated ? `${enemy.name} defeated!` : ''}`,
    });
    pendingLuckRoundId = enemy.defeated ? null : roundId;
  } else if (round.outcome === 'enemy_hits') {
    state.character.stamina.current = Math.max(0, state.character.stamina.current - round.damage);
    pushCombatLog(state, {
      type: 'attack_round',
      roundId,
      side: 'enemy',
      message: `You ${round.playerStrength} vs ${enemy.name} ${round.enemyStrength} — you're hit for ${round.damage}.`,
    });
    pendingLuckRoundId = state.character.stamina.current > 0 ? roundId : null;
  } else {
    pushCombatLog(state, {
      type: 'attack_round',
      roundId,
      side: 'draw',
      message: `You ${round.playerStrength} vs ${enemy.name} ${round.enemyStrength} — even strikes, no damage.`,
    });
    pendingLuckRoundId = null;
  }

  update();
}

function applyPendingLuck(state, update) {
  const entry = state.combatLog.find((e) => e.roundId === pendingLuckRoundId);
  if (!entry) return;
  const currentEnemy = state.enemies.find((e) => !e.defeated);
  const { roll, lucky, newLuck } = testLuck(state.character.luck.current);
  state.character.luck.current = newLuck;

  if (entry.side === 'player' && currentEnemy) {
    const adjusted = applyLuckToDamage(2, 'player', lucky);
    const already = 2;
    const delta = adjusted - already;
    currentEnemy.stamina -= delta;
    if (currentEnemy.stamina <= 0) {
      currentEnemy.defeated = true;
      normalizeCurrentEnemyIndex(state);
    }
    pushCombatLog(state, {
      type: 'luck_test',
      message: `Tested Luck on your hit: rolled ${roll.total} — ${lucky ? 'Lucky! Extra damage.' : 'Unlucky! Reduced damage.'} ${currentEnemy.name} now at ${Math.max(0, currentEnemy.stamina)} STAMINA. LUCK now ${newLuck}.`,
    });
  } else if (entry.side === 'enemy') {
    const adjusted = applyLuckToDamage(2, 'enemy', lucky);
    const already = 2;
    const delta = adjusted - already;
    state.character.stamina.current = Math.max(0, state.character.stamina.current + delta);
    pushCombatLog(state, {
      type: 'luck_test',
      message: `Tested Luck on the enemy's hit: rolled ${roll.total} — ${lucky ? 'Lucky! Less damage taken.' : 'Unlucky! Extra damage taken.'} You're now at ${Math.max(0, state.character.stamina.current)} STAMINA. LUCK now ${newLuck}.`,
    });
  }

  pendingLuckRoundId = null;
  update();
}

function clearCombat(state) {
  if (state.enemies.length > 0) {
    pushCombatLog(state, { type: 'combat_ended', message: 'Combat ended.' });
  }
  state.enemies = [];
  state.currentEnemyIndex = 0;
  pendingLuckRoundId = null;
}

function renderCombatLog(state) {
  if (state.combatLog.length === 0) return h('div');
  return h(
    'div',
    { class: 'combat-log' },
    h('h3', { class: 'sublabel' }, 'Play Log'),
    h(
      'ul',
      {},
      state.combatLog.slice(0, 15).map((entry) =>
        h(
          'li',
          { class: `log-entry log-${entry.type}` },
          h('span', { class: 'log-time' }, formatTime(entry.timestamp)),
          h('span', { class: 'log-message' }, entry.message)
        )
      )
    )
  );
}
