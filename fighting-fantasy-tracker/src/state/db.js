import { openDB } from 'idb';
import { newGameState } from './defaults.js';

const DB_NAME = 'ff-tracker-db';
const DB_VERSION = 1;
const SLOTS_STORE = 'slots';
const SETTINGS_STORE = 'settings';
const ACTIVE_SLOT_KEY = 'activeSlotId';

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(SLOTS_STORE)) {
          db.createObjectStore(SLOTS_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function listSlots() {
  const db = await getDB();
  const all = await db.getAll(SLOTS_STORE);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSlot(id) {
  const db = await getDB();
  return db.get(SLOTS_STORE, id);
}

export async function createSlot(name, state = newGameState(name)) {
  const db = await getDB();
  const now = Date.now();
  const id = await db.add(SLOTS_STORE, {
    name,
    createdAt: now,
    updatedAt: now,
    state,
  });
  await setActiveSlotId(id);
  return id;
}

export async function saveSlotState(id, state) {
  const db = await getDB();
  const existing = await db.get(SLOTS_STORE, id);
  if (!existing) throw new Error(`Save slot ${id} not found`);
  existing.state = state;
  existing.updatedAt = Date.now();
  await db.put(SLOTS_STORE, existing);
  return existing;
}

export async function renameSlot(id, name) {
  const db = await getDB();
  const existing = await db.get(SLOTS_STORE, id);
  if (!existing) throw new Error(`Save slot ${id} not found`);
  existing.name = name;
  await db.put(SLOTS_STORE, existing);
}

export async function deleteSlot(id) {
  const db = await getDB();
  await db.delete(SLOTS_STORE, id);
  const activeId = await getActiveSlotId();
  if (activeId === id) {
    const remaining = await listSlots();
    await setActiveSlotId(remaining[0]?.id ?? null);
  }
}

export async function getActiveSlotId() {
  const db = await getDB();
  const row = await db.get(SETTINGS_STORE, ACTIVE_SLOT_KEY);
  return row?.value ?? null;
}

export async function setActiveSlotId(id) {
  const db = await getDB();
  await db.put(SETTINGS_STORE, { key: ACTIVE_SLOT_KEY, value: id });
}

/** Ensures there is always at least one slot to work with; returns the active slot row. */
export async function ensureActiveSlot() {
  const activeId = await getActiveSlotId();
  if (activeId != null) {
    const slot = await getSlot(activeId);
    if (slot) return slot;
  }
  const slots = await listSlots();
  if (slots.length > 0) {
    await setActiveSlotId(slots[0].id);
    return slots[0];
  }
  const id = await createSlot('Adventure 1');
  return getSlot(id);
}

export function exportSlotJSON(slot) {
  return JSON.stringify(
    { name: slot.name, exportedAt: new Date().toISOString(), state: slot.state },
    null,
    2
  );
}

/** Validates the minimal shape expected of an imported save file. */
export function parseImportedSave(jsonText) {
  const parsed = JSON.parse(jsonText);
  const state = parsed.state ?? parsed;
  if (!state || typeof state !== 'object') throw new Error('Not a valid save file');
  if (!state.character || !state.nodes) throw new Error('Missing character or nodes data');
  return { name: parsed.name ?? state.bookTitle ?? 'Imported Adventure', state };
}

/** Debounced autosave: call save() on every state mutation, writes land ~400ms later. */
export function createAutosaver(delayMs = 400) {
  let timer = null;
  let pendingSlotId = null;
  let pendingState = null;
  return function save(slotId, state) {
    pendingSlotId = slotId;
    pendingState = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pendingSlotId != null && pendingState) {
        saveSlotState(pendingSlotId, pendingState).catch((err) =>
          console.error('Autosave failed', err)
        );
      }
    }, delayMs);
  };
}
