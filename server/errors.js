'use strict';
// Error carrying an HTTP status. Dependency-free so every module can require it.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = { HttpError };
