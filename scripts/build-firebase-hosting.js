#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const env = {
  ...process.env,
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL?.trim() || '/api/v1',
};

if (
  /localhost|127\.0\.0\.1/i.test(env.VITE_API_BASE_URL) &&
  process.env.ALLOW_LOCAL_FIREBASE_BUILD !== 'true'
) {
  console.error(
    `Refusing to build Firebase Hosting with local VITE_API_BASE_URL=${env.VITE_API_BASE_URL}. ` +
    'Unset it, use /api/v1, or set ALLOW_LOCAL_FIREBASE_BUILD=true for an intentional local test build.',
  );
  process.exit(1);
}

if (env.REQUIRE_AUTH === 'true') {
  const missingFirebaseValues = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_APP_ID',
  ].filter((name) => !env[name]?.trim());

  if (missingFirebaseValues.length > 0) {
    console.error(
      `Refusing to build authenticated Firebase Hosting bundle. Missing: ${missingFirebaseValues.join(', ')}.`,
    );
    console.error('Set these as GitHub repository variables or use REQUIRE_AUTH=false for local-only builds.');
    process.exit(1);
  }
}

const result = spawnSync('npm', ['run', 'build', '-w', '@newleaf/admin'], {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to run Firebase Hosting build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
