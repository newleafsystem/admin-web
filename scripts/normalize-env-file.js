#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENV_PATH = path.join(ROOT_DIR, '.env');
const DEFAULT_TEMPLATE_PATH = path.join(ROOT_DIR, '.env.example');
const DEPRECATED_KEYS = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_R2_BUCKET',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_QUEUES_NAMESPACE',
]);

const args = parseArgs(process.argv.slice(2));
const envPath = path.resolve(ROOT_DIR, args.envFile ?? DEFAULT_ENV_PATH);
const templatePath = path.resolve(ROOT_DIR, args.template ?? DEFAULT_TEMPLATE_PATH);

const existing = parseEnv(readFileSync(envPath, 'utf8'));
const template = readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const usedKeys = new Set();
const output = [];

for (const line of template) {
  const parsed = parseAssignment(line);
  if (!parsed) {
    output.push(line);
    continue;
  }

  usedKeys.add(parsed.key);
  const value = Object.prototype.hasOwnProperty.call(existing, parsed.key)
    ? existing[parsed.key]
    : parsed.value;
  output.push(`${parsed.key}=${serializeValue(value)}`);
}

const retained = Object.entries(existing)
  .filter(([key]) => !usedKeys.has(key) && !DEPRECATED_KEYS.has(key))
  .sort(([left], [right]) => left.localeCompare(right));

if (retained.length > 0) {
  output.push('');
  output.push('# Local-only values retained by scripts/normalize-env-file.js');
  for (const [key, value] of retained) {
    output.push(`${key}=${serializeValue(value)}`);
  }
}

writeFileSync(envPath, `${output.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');

const dropped = Object.keys(existing).filter((key) => DEPRECATED_KEYS.has(key));
console.log(`Normalized ${path.relative(ROOT_DIR, envPath)} using ${path.relative(ROOT_DIR, templatePath)}.`);
console.log(`Retained local-only keys: ${retained.length}`);
console.log(`Dropped deprecated keys: ${dropped.length}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env-file') {
      parsed.envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--template') {
      parsed.template = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/normalize-env-file.js [--env-file .env] [--template .env.example]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseEnv(content) {
  const result = {};
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const parsed = parseAssignment(line);
    if (parsed) {
      result[parsed.key] = parsed.value;
    }
  }
  return result;
}

function parseAssignment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  return {
    key: match[1],
    value: parseEnvValue(match[2]),
  };
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim();
  if (!value) return '';

  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }

  return value.replace(/\s+#.*$/, '').trim();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') {
      return index;
    }
  }
  return -1;
}

function serializeValue(value) {
  const normalized = String(value ?? '');
  if (!normalized || /^[A-Za-z0-9_./:@,+-]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}
