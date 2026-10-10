export type ErrorStatus = 400 | 401 | 404 | 409 | 422;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ErrorStatus,
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}
