import { h, clear } from '../lib/dom.js';
import { blankSectionNode } from '../state/defaults.js';

function getOrCreateNode(state, id) {
  if (!state.nodes[id]) {
    state.nodes[id] = blankSectionNode(id);
  }
  state.nodes[id].visited = true;
  return state.nodes[id];
}

function navigateTo(state, id) {
  if (!Number.isFinite(id)) return;
  getOrCreateNode(state, id);
  state.currentSectionId = id;
  state.history.push(id);
}

function goBack(state) {
  if (state.history.length <= 1) return;
  state.history.pop();
  state.currentSectionId = state.history[state.history.length - 1];
}

function jumpToBreadcrumb(state, index) {
  state.history = state.history.slice(0, index + 1);
  state.currentSectionId = state.history[state.history.length - 1];
}

export function renderSectionTracker(container, ctx) {
  const { state, update } = ctx;
  clear(container);

  const node = getOrCreateNode(state, state.currentSectionId);

  container.appendChild(renderCurrentSection(state, node, update));
  container.appendChild(renderChoices(state, node, update));
  container.appendChild(renderHistory(state, update));
  container.appendChild(renderVisitedList(state, update));
}

function renderCurrentSection(state, node, update) {
  const gotoInput = h('input', {
    type: 'number',
    class: 'num-input',
    placeholder: 'Section #',
    inputmode: 'numeric',
  });

  const titleInput = h('input', {
    type: 'text',
    class: 'text-input',
    placeholder: 'Section title (optional)',
    value: node.title ?? '',
    onChange: (e) => {
      node.title = e.target.value;
      update();
    },
  });

  const notesArea = h('textarea', {
    class: 'notes-input',
    placeholder: 'Notes for this section…',
    rows: 3,
    onChange: (e) => {
      node.notes = e.target.value;
      update();
    },
  });
  notesArea.value = node.notes ?? '';

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Section Tracker'),
    h('div', { class: 'current-section-display' }, `Section ${state.currentSectionId}`),
    titleInput,
    h(
      'form',
      {
        class: 'add-item-form',
        onSubmit: (e) => {
          e.preventDefault();
          const id = Number(gotoInput.value);
          if (!id) return;
          navigateTo(state, id);
          gotoInput.value = '';
          update();
        },
      },
      gotoInput,
      h('button', { type: 'submit', class: 'secondary-btn' }, 'Go To')
    ),
    h(
      'button',
      { class: 'text-btn', disabled: state.history.length <= 1, onClick: () => { goBack(state); update(); } },
      '← Back'
    ),
    h('h3', { class: 'sublabel' }, 'Notes'),
    notesArea
  );
}

function renderChoices(state, node, update) {
  const labelInput = h('input', { type: 'text', class: 'text-input', placeholder: 'Choice label' });
  const targetInput = h('input', { type: 'number', class: 'num-input', placeholder: 'Target #', inputmode: 'numeric' });
  const conditionInput = h('input', { type: 'text', class: 'text-input', placeholder: 'Condition (optional)' });

  function addChoice() {
    const targetId = Number(targetInput.value);
    if (!targetId) return;
    node.choices.push({
      targetId,
      label: labelInput.value.trim() || `Go to ${targetId}`,
      condition: conditionInput.value.trim() || undefined,
    });
    labelInput.value = '';
    targetInput.value = '';
    conditionInput.value = '';
    update();
  }

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Choices'),
    node.choices.length === 0
      ? h('p', { class: 'hint' }, 'No choices recorded yet.')
      : h(
          'ul',
          { class: 'choice-list' },
          node.choices.map((choice, index) =>
            h(
              'li',
              { class: 'choice-row' },
              h(
                'button',
                {
                  class: 'choice-go-btn',
                  onClick: () => {
                    navigateTo(state, choice.targetId);
                    update();
                  },
                },
                `${choice.label} → ${choice.targetId}`,
                choice.condition ? h('span', { class: 'choice-condition' }, ` (${choice.condition})`) : null
              ),
              h(
                'button',
                {
                  class: 'icon-btn',
                  'aria-label': 'Remove choice',
                  onClick: () => {
                    node.choices.splice(index, 1);
                    update();
                  },
                },
                '✕'
              )
            )
          )
        ),
    h(
      'form',
      {
        class: 'add-choice-form',
        onSubmit: (e) => {
          e.preventDefault();
          addChoice();
        },
      },
      labelInput,
      targetInput,
      conditionInput,
      h('button', { type: 'submit', class: 'secondary-btn' }, 'Add Choice')
    )
  );
}

function renderHistory(state, update) {
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Path Taken'),
    h(
      'ol',
      { class: 'history-trail' },
      state.history.map((id, index) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: index === state.history.length - 1 ? 'crumb-btn active' : 'crumb-btn',
              onClick: () => {
                jumpToBreadcrumb(state, index);
                update();
              },
            },
            id
          )
        )
      )
    )
  );
}

function renderVisitedList(state, update) {
  const visitedIds = Object.values(state.nodes)
    .filter((n) => n.visited)
    .map((n) => n.id)
    .sort((a, b) => a - b);

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Visited Sections'),
    h(
      'div',
      { class: 'visited-grid' },
      visitedIds.map((id) =>
        h(
          'button',
          {
            class: id === state.currentSectionId ? 'visited-chip active' : 'visited-chip',
            onClick: () => {
              navigateTo(state, id);
              update();
            },
          },
          id
        )
      )
    )
  );
}
