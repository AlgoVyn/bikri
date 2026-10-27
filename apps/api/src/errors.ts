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
  /** Extra response headers, e.g. `Retry-After`. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: string,
    status: ErrorStatus,
    message: string,
    details?: unknown,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}
