import { HttpError } from '../lib/httpErrors.js';

export function notFoundHandler(req, res, next) {
  next(new HttpError(404, 'Route not found', { method: req.method, path: req.originalUrl }));
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const status = error instanceof HttpError ? error.status : error.statusCode ?? error.status ?? 500;
  const response = {
    error: {
      message: status >= 500 ? 'Internal server error' : error.message,
      requestId: req.requestId,
    },
  };

  if (error instanceof HttpError && error.details !== undefined) {
    response.error.details = error.details;
  }

  if (status >= 500) {
    console.error('Unhandled API error', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      error,
    });
  }

  return res.status(status).json(response);
}
