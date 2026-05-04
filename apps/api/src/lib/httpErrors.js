export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = 'Unauthorized', details) {
  return new HttpError(401, message, details);
}

export function forbidden(message = 'Forbidden', details) {
  return new HttpError(403, message, details);
}

export function notFound(message = 'Not found', details) {
  return new HttpError(404, message, details);
}

export function conflict(message, details) {
  return new HttpError(409, message, details);
}

export function tooManyRequests(message = 'Too many requests', details) {
  return new HttpError(429, message, details);
}

export function assertHttp(condition, error) {
  if (!condition) {
    throw error;
  }
}
