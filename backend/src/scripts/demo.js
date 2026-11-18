import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One-command local demo (`npm run demo` from the repo root). No MongoDB install or .env needed:
 * starts a throwaway MongoDB replica set in memory, loads the synthetic demo data, and runs the API
 * and the web app. Phone calls are simulated. Everything is wiped when you press Ctrl+C.
 * With --api-only (`npm run dev:demo` in backend/), only the API runs; start the web app yourself.
 * Development only (mongodb-memory-server is a dev dependency).
 */

const API_PORT = Number(process.env.DEMO_API_PORT || 5050); // 5000 is taken by AirPlay on many Macs
const UI_PORT = Number(process.env.DEMO_UI_PORT || 5173);
const API_ONLY = process.argv.includes('--api-only');
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, '../../../frontend');

console.log('[Demo] Starting a temporary in-memory MongoDB (the first run downloads it, about a minute)...');
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

// Set before the app's config module loads; values in backend/.env never override these
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: replSet.getUri(),
  MONGODB_DB_NAME: 'careloop_demo',
  VOICE_MOCK_MODE: 'true',
  PORT: String(API_PORT),
  CLIENT_URL: `http://localhost:${UI_PORT}`
});

const { runSeeds } = await import('./seedRunner.js');
const { seedClinician } = await import('./seedUsers.js');
const { seedProvidersAndSchedules } = await import('./seedAppointments.js');
const { seedDirectory } = await import('./seedDirectory.js');
const { seedPatients } = await import('./seedPatientUsers.js');
const { seedCarePlans } = await import('./seedCarePlans.js');
await runSeeds('Demo Data', [seedClinician, seedProvidersAndSchedules, seedDirectory, seedPatients, seedCarePlans]);

const { app } = await import('../app.js');
const { connectDb, closeDb } = await import('../config/db.js');
const { initAllIndexes } = await import('../config/indexes.js');
const { startAgentScheduler } = await import('../services/orchestrator.service.js');
const { getAgentStatus } = await import('../services/orchestrator.service.js');

await connectDb();
await initAllIndexes();
startAgentScheduler();

const server = app.listen(API_PORT);
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
}).catch(async (err) => {
  console.error(`[Demo] Could not start the API on port ${API_PORT} (${err.code}). Try: DEMO_API_PORT=5060 npm run demo`);
  await replSet.stop();
  process.exit(1);
});

const banner = (heading, extra = '') => `
============================================================
  ${heading}
${extra}
  Open:  http://localhost:${UI_PORT}
  API:   http://localhost:${API_PORT}/api/health

  Clinician login:  clinician@careloop.local / CareLoop2026!
  Patient logins:   patient@careloop.local  / CareLoopPatient2026!  (Sunita Devi)
                    patient2@careloop.local / CareLoopPatient2026!  (Ramesh Kumar)

  Agent decides with: ${getAgentStatus().decider}
  All data is synthetic, phone calls are simulated, and
  everything is wiped when you press Ctrl+C.
============================================================
`;

let web = null;
if (API_ONLY) {
  console.log(banner('CareLoop backend (demo database) is running', `
  Now start the web app in a second terminal:
    cd frontend && npm run dev
`));
} else {
  web = spawn('npm', ['run', 'dev', '--', '--port', String(UI_PORT), '--strictPort'], {
    cwd: frontendDir,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, VITE_API_URL: `http://localhost:${API_PORT}` }
  });

  let announced = false;
  web.stdout.on('data', (chunk) => {
    if (announced || !String(chunk).includes('ready')) return;
    announced = true;
    console.log(banner('CareLoop + PlanPilot demo is running'));
  });
}

web?.on('exit', (code) => {
  if (code && !shuttingDown) {
    console.error(`[Demo] The web app stopped (port ${UI_PORT} may be in use). Try: DEMO_UI_PORT=5180 npm run demo`);
    shutdown();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[Demo] Stopping and wiping the demo database...');
  web?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  await replSet.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
