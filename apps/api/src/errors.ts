export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 413
  | 415
  | 429
  | 500
  | 503;

export class ApiError extends Error {
  readonly code: string;
  readonly status: ErrorStatus;
  readonly details: unknown;

  constructor(
    code: string,
    status: ErrorStatus,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
