/**
 * Application error hierarchy.
 * All thrown errors should be instances of AppError or its subclasses.
 * The global error middleware maps these to RFC 7807 Problem Details responses.
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly title: string,
    public readonly detail: string,
    public readonly errorType: string,
    public readonly extra?: Record<string, unknown>
  ) {
    super(detail);
    this.name = 'AppError';
    // Capture stack trace (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ValidationError extends AppError {
  constructor(detail: string, public readonly fields?: Record<string, string[]>) {
    super(400, 'Validation Error', detail, 'validation-error', fields ? { fields } : undefined);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication required') {
    super(401, 'Unauthorized', detail, 'unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have permission to perform this action') {
    super(403, 'Forbidden', detail, 'forbidden');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(detail: string) {
    super(404, 'Not Found', detail, 'not-found');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, extra?: Record<string, unknown>) {
    super(409, 'Conflict', detail, 'conflict', extra);
    this.name = 'ConflictError';
  }
}

export class InternalError extends AppError {
  constructor(detail = 'An unexpected error occurred') {
    super(500, 'Internal Server Error', detail, 'internal-error');
    this.name = 'InternalError';
  }
}
