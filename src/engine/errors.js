"use strict";

/**
 * An error whose { code, message, ...extra } shape is safe to return to the
 * MCP caller verbatim. Anything else that escapes the engine is an internal
 * fault and must not leak details to the client.
 */
class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.extra = extra;
  }

  toResponse() {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

/** Optimistic-concurrency failure raised by a run store on an ETag mismatch. */
class StoreConflictError extends Error {
  constructor(message = "The run was modified concurrently.") {
    super(message);
    this.name = "StoreConflictError";
  }
}

// Steps 5-9 of walk all collapse into this one response on purpose: a
// distinct "route not found" would leak the existence of guessed secret
// routes. Never specialise it.
function routeUnavailable() {
  return new EngineError(
    "route_unavailable",
    "That route is not available from the current position."
  );
}

module.exports = { EngineError, StoreConflictError, routeUnavailable };
