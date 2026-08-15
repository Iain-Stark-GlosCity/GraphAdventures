/** Minimal hyperscript-style DOM builder. Never uses innerHTML with user
 * data, so inventory items / notes / labels can never inject markup. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el && key !== 'list') {
      try {
        el[key] = value;
      } catch {
        el.setAttribute(key, value);
      }
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

export function mount(container, ...children) {
  clear(container);
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    container.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
