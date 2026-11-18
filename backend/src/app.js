import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { getDb } from './config/db.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { providerRouter } from './routes/provider.routes.js';
import { availabilityRouter } from './routes/availability.routes.js';
import { appointmentRouter } from './routes/appointment.routes.js';
import { voiceRouter } from './routes/voice.routes.js';
import { patientRouter } from './routes/patient.routes.js';
import { patientRegistryRouter } from './routes/patientRegistry.routes.js';
import { carePlanRouter, careTaskRouter } from './routes/carePlan.routes.js';
import { directoryRouter } from './routes/directory.routes.js';
import { reviewQueueRouter, approvalRouter, documentSubmissionRouter } from './routes/review.routes.js';
import { demoRouter } from './routes/demo.routes.js';
import { healthCheckRouter } from './routes/healthCheck.routes.js';

export const app = express();
 
// Configure reverse proxy trust
if (env.TRUST_PROXY) {
  const setting = env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY;
  app.set('trust proxy', setting);
}

// Configure CORS for local Vite frontend
const allowedOrigins = env.CLIENT_URL.split(',').map(origin => origin.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, or server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true
}));

// Cookie parsing middleware
app.use(cookieParser());

// JSON request parsing (document uploads carry a base64 file, so they get a larger limit)
const documentUploadJson = express.json({ limit: '4mb' });
app.use((req, res, next) => (req.method === 'POST' && req.path.endsWith('/documents') ? documentUploadJson(req, res, next) : next()));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Health check routes
app.use('/api/health', healthRouter);

// While the database is still connecting (just after start-up, or after a network hiccup), say so
// plainly. Otherwise each route fails in its own way: a login would answer "Invalid email or
// password" and lists would look empty. Health checks and logout do not need the database.
app.use('/api', (req, res, next) => {
  if (getDb() || !env.MONGODB_URI || req.path === '/auth/logout') return next();
  res.set('Retry-After', '3').status(503).json({
    error: 'DatabaseUnavailable',
    code: 'DB_CONNECTING',
    message: 'The database is still connecting. Please wait a few seconds and try again.',
    status: 503
  });
});

// Authentication routes
app.use('/api/auth', authRouter);

// Providers & Availability routes
app.use('/api/providers', providerRouter);
app.use('/api/availability', availabilityRouter);

// Appointments & Slot Engine routes
app.use('/api/appointments', appointmentRouter);

// Voice Telephony & Agent routes
app.use('/api/voice', voiceRouter);

// Patient Self-Service Portal routes (M6)
app.use('/api/patient', patientRouter);

// PlanPilot: patient registry, care plans, and care-plan tasks (clinician workspace)
app.use('/api/patients', patientRegistryRouter);
app.use('/api/care-plans', carePlanRouter);
app.use('/api/care-tasks', careTaskRouter);
app.use('/api/directory', directoryRouter);
app.use('/api/review-queue', reviewQueueRouter);
app.use('/api/approvals', approvalRouter);
app.use('/api/document-submissions', documentSubmissionRouter);
app.use('/api/demo', demoRouter);
app.use('/api/health-checks', healthCheckRouter);

// Root route convenience
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to CareLoop API',
    documentation: '/api/health',
    status: 'online'
  });
});

// 404 Handler for undefined routes
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    status: 404
  });
});

// Centralized error handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Error] ${err.name}: ${err.message}`, err.stack);

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred.',
    status: statusCode
  });
});
