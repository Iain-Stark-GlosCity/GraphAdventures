import './style.css';
import { h, mount, clear } from './lib/dom.js';
import { ensureActiveSlot, createAutosaver } from './state/db.js';
import { renderTabBar } from './ui/tabbar.js';
import { renderDiceCombat } from './ui/diceCombatView.js';
import { renderCharacter } from './ui/characterView.js';
import { renderSectionTracker } from './ui/sectionTrackerView.js';
import { openSaveModal } from './ui/saveModal.js';

const TABS = [
  { id: 'combat', label: 'Dice / Combat', icon: '🎲', render: renderDiceCombat },
  { id: 'character', label: 'Character', icon: '🛡', render: renderCharacter },
  { id: 'sections', label: 'Sections', icon: '🗺', render: renderSectionTracker },
];

const autosave = createAutosaver();

async function boot() {
  const slot = await ensureActiveSlot();

  const app = {
    slotId: slot.id,
    state: slot.state,
    activeTab: TABS[0].id,
  };

  const root = document.getElementById('app');

  const saveBtn = h('button', { class: 'header-save-btn', 'aria-label': 'Save slots' }, '💾');
  const header = h(
    'header',
    { class: 'app-header' },
    h('span', { class: 'app-title' }, 'Fighting Fantasy Tracker'),
    saveBtn
  );

  const tabPanel = h('main', { class: 'tab-panel' });
  const tabbar = h('nav', { class: 'tab-bar' });

  mount(root, header, tabPanel, tabbar);

  function update() {
    autosave(app.slotId, app.state);
    renderActiveTab();
  }

  function renderActiveTab() {
    clear(tabPanel);
    const tab = TABS.find((t) => t.id === app.activeTab);
    tab.render(tabPanel, { state: app.state, update });
  }

  function renderNav() {
    renderTabBar(tabbar, {
      tabs: TABS,
      activeTab: app.activeTab,
      onSelect: (id) => {
        app.activeTab = id;
        renderNav();
        renderActiveTab();
      },
    });
  }

  saveBtn.addEventListener('click', () => {
    openSaveModal({
      slotId: app.slotId,
      state: app.state,
      onSlotSwitched: (newSlotId, newState) => {
        app.slotId = newSlotId;
        app.state = newState;
        renderActiveTab();
      },
    });
  });

  renderNav();
  renderActiveTab();
}

boot();
