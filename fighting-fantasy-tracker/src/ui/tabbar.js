import { h, mount } from '../lib/dom.js';

export function renderTabBar(container, { tabs, activeTab, onSelect }) {
  mount(
    container,
    ...tabs.map((tab) =>
      h(
        'button',
        {
          class: tab.id === activeTab ? 'tab-btn active' : 'tab-btn',
          onClick: () => onSelect(tab.id),
          'aria-current': tab.id === activeTab ? 'page' : null,
        },
        h('span', { class: 'tab-icon' }, tab.icon),
        h('span', { class: 'tab-label' }, tab.label)
      )
    )
  );
}
