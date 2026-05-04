import { badRequest } from './httpErrors.js';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function requireObject(value, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object`);
  }
  return value;
}

export function rejectUnknownFields(value, allowedFields, label = 'body') {
  const unknown = Object.keys(value).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`${label} contains unsupported fields`, { unknown, allowedFields });
  }
}

export function requireString(value, field, options = {}) {
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 500;
  if (typeof value[field] !== 'string') {
    throw badRequest(`${field} must be a string`);
  }
  const trimmed = value[field].trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw badRequest(`${field} must be between ${minLength} and ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalString(value, field, options = {}) {
  if (!hasOwn(value, field) || value[field] === null || value[field] === undefined) {
    return options.defaultValue;
  }
  return requireString(value, field, options);
}

export function optionalNumber(value, field, options = {}) {
  if (!hasOwn(value, field) || value[field] === null || value[field] === undefined) {
    return options.defaultValue;
  }
  const numberValue = Number(value[field]);
  if (!Number.isFinite(numberValue)) {
    throw badRequest(`${field} must be a number`);
  }
  if (options.min !== undefined && numberValue < options.min) {
    throw badRequest(`${field} must be greater than or equal to ${options.min}`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    throw badRequest(`${field} must be less than or equal to ${options.max}`);
  }
  return numberValue;
}

export function optionalObject(value, field, options = {}) {
  if (!hasOwn(value, field) || value[field] === null || value[field] === undefined) {
    return options.defaultValue;
  }
  return requireObject(value[field], field);
}

export function optionalStringArray(value, field, options = {}) {
  if (!hasOwn(value, field) || value[field] === null || value[field] === undefined) {
    return options.defaultValue ?? [];
  }
  if (!Array.isArray(value[field])) {
    throw badRequest(`${field} must be an array`);
  }
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? 50;
  if (value[field].length < minItems || value[field].length > maxItems) {
    throw badRequest(`${field} must contain between ${minItems} and ${maxItems} items`);
  }
  return value[field].map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw badRequest(`${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

export function requireAllowed(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${field} is not supported`, { allowedValues });
  }
  return value;
}

export function pickDefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
