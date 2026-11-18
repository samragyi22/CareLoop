import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { connectDb, closeDb } from '../config/db.js';
import { initAllIndexes } from '../config/indexes.js';

/**
 * True when the calling module was executed directly (`node script.js`) rather than imported.
 */
export function isDirectRun(importMetaUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(importMetaUrl) === path.resolve(process.argv[1]);
}

/**
 * Connects once, ensures indexes, runs the given seed steps in order, and always disconnects.
 * Seeding is refused in production.
 */
export async function runSeeds(label, steps) {
  if (env.NODE_ENV === 'production') {
    console.error('[Seed Error] Database seeding is strictly disabled in production environments.');
    process.exit(1);
  }

  console.log(`--- CareLoop Seeder: ${label} ---`);
  const db = await connectDb();
  if (!db) {
    console.error('[Seed Error] Failed to connect to MongoDB. Verify MONGODB_URI in backend/.env.');
    process.exit(1);
  }

  try {
    await initAllIndexes();
    for (const step of steps) {
      await step();
    }
    console.log('--- Seeding Finished ---');
  } catch (err) {
    console.error('[Seed Error]:', err.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
