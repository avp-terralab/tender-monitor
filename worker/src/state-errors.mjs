export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
