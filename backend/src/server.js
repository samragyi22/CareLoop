import { app } from './app.js';
import { env, assertProductionSafety } from './config/env.js';
import { connectDbInBackground, closeDb } from './config/db.js';
import { initAllIndexes } from './config/indexes.js';
import { startAgentScheduler } from './services/orchestrator.service.js';
import { warmHealthCheckCache } from './services/symptomCheck.service.js';

let server;

async function startServer() {
  try {
    // Refuse to boot production with unsafe defaults (shared JWT secret, mock telephony)
    assertProductionSafety();

    // Open the port first so the dashboard always gets an answer (while the database is still
    // connecting, requests get a clear "database still connecting" reply), then connect the
    // database in the background, retrying until it answers
    server = app.listen(env.PORT, () => {
      console.log(`===============================================`);
      console.log(`  CareLoop Backend API`);
      console.log(`  Environment: ${env.NODE_ENV}`);
      console.log(`  Port:        ${env.PORT}`);
      console.log(`  Health Check: http://localhost:${env.PORT}/api/health`);
      console.log(`  DB Health:    http://localhost:${env.PORT}/api/health/db`);
      console.log(`===============================================`);
    });

    server.on('error', (err) => {
      console.error('[Server] Fatal startup error:', err.message);
      process.exit(1);
    });

    connectDbInBackground(() => {
      // Indexes are confirmed in the background: on a distant database this can take several
      // seconds, and the server should answer calls immediately (the indexes already exist after
      // the first start)
      initAllIndexes()
        .then(() => console.log('[MongoDB] All collections & indexes initialized.'))
        .catch(indexErr => console.warn('[MongoDB] Index creation warning:', indexErr.message));
      startAgentScheduler();
      warmHealthCheckCache();
    });
  } catch (err) {
    console.error('[Server] Initialization failed:', err.message);
    process.exit(1);
  }
}

// Graceful shutdown handling
const handleGracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);
  if (server) {
    server.close(async () => {
      console.log('[Server] HTTP server closed.');
      await closeDb();
      process.exit(0);
    });
  } else {
    await closeDb();
    process.exit(0);
  }
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

startServer();
