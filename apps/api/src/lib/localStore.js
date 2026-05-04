import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export async function createLocalStore(options = {}) {
  const rootDir = path.resolve(process.cwd(), options.rootDir ?? config.localDataDir);
  const writeQueues = new Map();
  await fs.mkdir(rootDir, { recursive: true });

  function enqueueWrite(filePath, task) {
    const previous = writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    writeQueues.set(filePath, next);
    return next.finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath);
      }
    });
  }

  return {
    async readJson(fileName, fallback) {
      const filePath = path.join(rootDir, fileName);
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          return fallback;
        }
        throw error;
      }
    },
    async writeJson(fileName, value) {
      const filePath = path.join(rootDir, fileName);
      const payload = `${JSON.stringify(value, null, 2)}\n`;

      await enqueueWrite(filePath, async () => {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(tempPath, payload, 'utf8');
          await fs.rename(tempPath, filePath);
        } catch (error) {
          await fs.unlink(tempPath).catch(() => {});
          throw error;
        }
      });
    },
  };
}
