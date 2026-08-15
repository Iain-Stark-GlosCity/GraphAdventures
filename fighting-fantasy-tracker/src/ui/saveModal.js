import { h, clear } from '../lib/dom.js';
import { formatTime } from '../lib/format.js';
import {
  listSlots,
  createSlot,
  saveSlotState,
  renameSlot,
  deleteSlot,
  setActiveSlotId,
  getActiveSlotId,
  exportSlotJSON,
  parseImportedSave,
  getSlot,
} from '../state/db.js';

export async function openSaveModal({ slotId, state, onSlotSwitched }) {
  // Flush the latest in-memory state to the current slot before doing
  // anything else, so switching away never loses unsaved changes.
  await saveSlotState(slotId, state);

  const overlay = h('div', { class: 'modal-overlay' });
  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const panel = h('div', { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true' });
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  await renderPanel();

  async function renderPanel() {
    clear(panel);
    const slots = await listSlots();

    const newNameInput = h('input', { type: 'text', class: 'text-input', placeholder: 'New adventure name' });
    const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'file-input' });

    panel.appendChild(
      h('div', { class: 'modal-header' }, h('h2', {}, 'Save Slots'), h('button', { class: 'icon-btn', onClick: closeModal }, '✕'))
    );

    panel.appendChild(
      h(
        'ul',
        { class: 'slot-list' },
        slots.map((slot) =>
          h(
            'li',
            { class: slot.id === slotId ? 'slot-row active' : 'slot-row' },
            h(
              'div',
              { class: 'slot-info' },
              h('div', { class: 'slot-name' }, slot.name),
              h('div', { class: 'slot-meta' }, `${slot.state.bookTitle} · Section ${slot.state.currentSectionId} · ${formatTime(slot.updatedAt)}`)
            ),
            h(
              'div',
              { class: 'slot-actions' },
              slot.id !== slotId
                ? h(
                    'button',
                    {
                      class: 'secondary-btn small',
                      onClick: async () => {
                        await setActiveSlotId(slot.id);
                        const fresh = await getSlot(slot.id);
                        onSlotSwitched(fresh.id, fresh.state);
                        closeModal();
                      },
                    },
                    'Load'
                  )
                : h('span', { class: 'current-badge' }, 'Current'),
              h(
                'button',
                {
                  class: 'text-btn small',
                  onClick: async () => {
                    const name = window.prompt('Rename adventure', slot.name);
                    if (!name) return;
                    await renameSlot(slot.id, name);
                    renderPanel();
                  },
                },
                'Rename'
              ),
              h(
                'button',
                {
                  class: 'icon-btn',
                  'aria-label': `Delete ${slot.name}`,
                  onClick: async () => {
                    if (!window.confirm(`Delete save "${slot.name}"? This cannot be undone.`)) return;
                    await deleteSlot(slot.id);
                    if (slot.id === slotId) {
                      let activeId = await getActiveSlotId();
                      if (activeId == null) activeId = await createSlot('Adventure 1');
                      const fresh = await getSlot(activeId);
                      onSlotSwitched(fresh.id, fresh.state);
                    }
                    renderPanel();
                  },
                },
                '🗑'
              ),
              h(
                'button',
                {
                  class: 'text-btn small',
                  onClick: () => {
                    const json = exportSlotJSON(slot);
                    downloadFile(`${slugify(slot.name)}.json`, json);
                  },
                },
                'Export'
              )
            )
          )
        )
      )
    );

    panel.appendChild(
      h(
        'form',
        {
          class: 'add-item-form',
          onSubmit: async (e) => {
            e.preventDefault();
            const name = newNameInput.value.trim();
            if (!name) return;
            const id = await createSlot(name);
            const fresh = await getSlot(id);
            onSlotSwitched(fresh.id, fresh.state);
            closeModal();
          },
        },
        newNameInput,
        h('button', { type: 'submit', class: 'secondary-btn' }, 'New Adventure')
      )
    );

    panel.appendChild(
      h(
        'div',
        { class: 'import-row' },
        importInput,
        h(
          'button',
          {
            class: 'secondary-btn',
            onClick: async () => {
              const file = importInput.files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const { name, state: importedState } = parseImportedSave(text);
                const id = await createSlot(name, importedState);
                const fresh = await getSlot(id);
                onSlotSwitched(fresh.id, fresh.state);
                closeModal();
              } catch (err) {
                window.alert(`Import failed: ${err.message}`);
              }
            },
          },
          'Import JSON'
        )
      )
    );
  }
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'save';
}
