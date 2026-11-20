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
