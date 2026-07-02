"use strict";

const { BlobServiceClient } = require("@azure/storage-blob");
const { StoreConflictError } = require("../engine/errors");

const CONTAINER_NAME = "adventure-runs";

/**
 * One blob per run in the adventure-runs container: run:{run_id}.json.
 * Optimistic concurrency via blob ETags — create requires the blob not to
 * exist, update requires If-Match on the ETag read alongside the document.
 */
class BlobRunStore {
  constructor(connectionString, containerName = CONTAINER_NAME) {
    const service = BlobServiceClient.fromConnectionString(connectionString);
    this.container = service.getContainerClient(containerName);
    this._ready = null;
  }

  _ensureContainer() {
    if (!this._ready) this._ready = this.container.createIfNotExists();
    return this._ready;
  }

  _blob(runId) {
    return this.container.getBlockBlobClient(`run:${runId}.json`);
  }

  async create(runId, doc) {
    await this._ensureContainer();
    const body = JSON.stringify(doc);
    try {
      await this._blob(runId).upload(body, Buffer.byteLength(body), {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    } catch (e) {
      if (e.statusCode === 409 || e.statusCode === 412) {
        throw new StoreConflictError(`Run ${runId} already exists.`);
      }
      throw e;
    }
  }

  async read(runId) {
    await this._ensureContainer();
    let response;
    try {
      response = await this._blob(runId).download(0);
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { doc, etag: response.etag };
  }

  async update(runId, doc, etag) {
    const body = JSON.stringify(doc);
    try {
      await this._blob(runId).upload(body, Buffer.byteLength(body), {
        conditions: { ifMatch: etag },
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    } catch (e) {
      if (e.statusCode === 412 || e.statusCode === 409) {
        throw new StoreConflictError();
      }
      throw e;
    }
  }
}

module.exports = { BlobRunStore, CONTAINER_NAME };
