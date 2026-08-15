export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
