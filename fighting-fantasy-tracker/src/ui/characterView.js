import { h, clear } from '../lib/dom.js';
import { newCharacterSheet } from '../state/defaults.js';

export function renderCharacter(container, ctx) {
  const { state, update } = ctx;
  clear(container);

  container.appendChild(renderBookTitle(state, update));
  container.appendChild(renderStatBlock(state, update));
  container.appendChild(renderGoldProvisions(state, update));
  container.appendChild(renderInventory(state, update));
  container.appendChild(renderRollNewCharacter(state, update));
}

function renderBookTitle(state, update) {
  const input = h('input', {
    type: 'text',
    class: 'text-input title-input',
    value: state.bookTitle,
    placeholder: 'Adventure title',
    onChange: (e) => {
      state.bookTitle = e.target.value;
      update();
    },
  });
  return h('section', { class: 'card' }, h('h2', {}, 'Adventurer'), input);
}

function statRow(label, key, character, update, { max } = {}) {
  const stat = character[key];
  const step = (delta) => {
    stat.current = Math.max(0, max != null ? Math.min(max, stat.current + delta) : stat.current + delta);
    update();
  };
  return h(
    'div',
    { class: 'stat-row' },
    h('div', { class: 'stat-label' }, label, h('span', { class: 'stat-initial' }, `Initial ${stat.initial}`)),
    h(
      'div',
      { class: 'stepper' },
      h('button', { class: 'stepper-btn', 'aria-label': `Decrease ${label}`, onClick: () => step(-1) }, '−'),
      h('span', { class: 'stepper-value' }, stat.current),
      h('button', { class: 'stepper-btn', 'aria-label': `Increase ${label}`, onClick: () => step(1) }, '+'),
      h(
        'button',
        {
          class: 'text-btn small',
          onClick: () => {
            stat.current = stat.initial;
            update();
          },
        },
        'Restore'
      )
    )
  );
}

function renderStatBlock(state, update) {
  const c = state.character;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Stats'),
    statRow('SKILL', 'skill', c, update),
    statRow('STAMINA', 'stamina', c, update),
    statRow('LUCK', 'luck', c, update)
  );
}

function counterRow(label, key, character, update, { min = 0, quickAction } = {}) {
  const step = (delta) => {
    character[key] = Math.max(min, character[key] + delta);
    update();
  };
  const valueInput = h('input', {
    type: 'number',
    class: 'num-input counter-input',
    value: character[key],
    inputmode: 'numeric',
    onChange: (e) => {
      const v = Number(e.target.value);
      character[key] = Number.isFinite(v) ? Math.max(min, v) : character[key];
      update();
    },
  });
  return h(
    'div',
    { class: 'stat-row' },
    h('div', { class: 'stat-label' }, label),
    h(
      'div',
      { class: 'stepper' },
      h('button', { class: 'stepper-btn', 'aria-label': `Decrease ${label}`, onClick: () => step(-1) }, '−'),
      valueInput,
      h('button', { class: 'stepper-btn', 'aria-label': `Increase ${label}`, onClick: () => step(1) }, '+'),
      quickAction
    )
  );
}

function renderGoldProvisions(state, update) {
  const c = state.character;
  const eatProvision = h(
    'button',
    {
      class: 'text-btn small',
      disabled: c.provisions <= 0,
      onClick: () => {
        c.provisions = Math.max(0, c.provisions - 1);
        c.stamina.current = Math.min(c.stamina.initial, c.stamina.current + 4);
        update();
      },
    },
    'Eat (+4 STA)'
  );
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Resources'),
    counterRow('GOLD', 'gold', c, update),
    counterRow('PROVISIONS', 'provisions', c, update, { quickAction: eatProvision })
  );
}

function renderInventory(state, update) {
  const c = state.character;
  const input = h('input', { type: 'text', class: 'text-input', placeholder: 'Add item…' });

  function addItem() {
    const value = input.value.trim();
    if (!value) return;
    c.inventory.push(value);
    input.value = '';
    update();
  }

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Inventory'),
    h(
      'form',
      {
        class: 'add-item-form',
        onSubmit: (e) => {
          e.preventDefault();
          addItem();
        },
      },
      input,
      h('button', { type: 'submit', class: 'secondary-btn' }, 'Add')
    ),
    c.inventory.length === 0
      ? h('p', { class: 'hint' }, 'No items yet.')
      : h(
          'ul',
          { class: 'inventory-list' },
          c.inventory.map((item, index) =>
            h(
              'li',
              {},
              h('span', {}, item),
              h(
                'button',
                {
                  class: 'icon-btn',
                  'aria-label': `Remove ${item}`,
                  onClick: () => {
                    c.inventory.splice(index, 1);
                    update();
                  },
                },
                '✕'
              )
            )
          )
        )
  );
}

function renderRollNewCharacter(state, update) {
  return h(
    'section',
    { class: 'card' },
    h(
      'button',
      {
        class: 'danger-btn',
        onClick: () => {
          if (!window.confirm('Replace current stats and inventory with a freshly rolled character?')) return;
          state.character = newCharacterSheet();
          update();
        },
      },
      'Roll New Character'
    ),
    h('p', { class: 'hint' }, 'SKILL = 1d6+6, STAMINA = 2d6+12, LUCK = 1d6+6. Resets inventory, gold and provisions.')
  );
}
