// Typed errors (ARCHITECTURE §9). The central error middleware maps them to responses.

/** Bad input from a caller or from the AI: maps to HTTP 400. */
export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

/** Unknown record: maps to HTTP 404. */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/** Record exists but is in the wrong state for this action: maps to HTTP 409. */
export class ConflictError extends Error {
  constructor(message = 'Conflict') {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
