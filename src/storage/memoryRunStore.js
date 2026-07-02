"use strict";

const { StoreConflictError } = require("../engine/errors");

/** In-memory run store with the same contract as BlobRunStore, for tests. */
class MemoryRunStore {
  constructor() {
    this.runs = new Map();
    this._etagCounter = 0;
  }

  async create(runId, doc) {
    if (this.runs.has(runId)) throw new StoreConflictError(`Run ${runId} already exists.`);
    this.runs.set(runId, { doc: structuredClone(doc), etag: `"${++this._etagCounter}"` });
  }

  async read(runId) {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    return { doc: structuredClone(entry.doc), etag: entry.etag };
  }

  async update(runId, doc, etag) {
    const entry = this.runs.get(runId);
    if (!entry || entry.etag !== etag) throw new StoreConflictError();
    this.runs.set(runId, { doc: structuredClone(doc), etag: `"${++this._etagCounter}"` });
  }
}

module.exports = { MemoryRunStore };
