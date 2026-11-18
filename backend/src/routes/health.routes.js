import express from 'express';
import { getDbStatus } from '../config/db.js';
import { env } from '../config/env.js';

export const healthRouter = express.Router();

/**
 * GET /api/health
 * Returns API operational status, service information, uptime, and timestamp.
 */
healthRouter.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'CareLoop Backend API',
    version: '1.0.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

/**
 * GET /api/health/db
 * Reports real database connection status.
 */
healthRouter.get('/db', (req, res) => {
  const dbStatus = getDbStatus();
  
  if (dbStatus.status === 'connected') {
    return res.status(200).json({
      status: 'connected',
      service: 'MongoDB',
      database: dbStatus.database,
      isConfigured: true,
      message: 'Database is connected and responsive.'
    });
  }

  if (dbStatus.status === 'unconfigured') {
    return res.status(200).json({
      status: 'unconfigured',
      service: 'MongoDB',
      database: dbStatus.database,
      isConfigured: false,
      message: 'MONGODB_URI is not set in backend environment. Database operations are currently offline.'
    });
  }

  if (dbStatus.status === 'connecting') {
    return res.status(503).json({
      status: 'connecting',
      service: 'MongoDB',
      database: dbStatus.database,
      isConfigured: true,
      message: 'MongoDB is still connecting. This takes a few seconds after the server starts.',
      error: dbStatus.error || null
    });
  }

  // Otherwise disconnected or connection error
  return res.status(503).json({
    status: 'disconnected',
    service: 'MongoDB',
    database: dbStatus.database,
    isConfigured: true,
    message: 'MongoDB connection failed or is disconnected.',
    error: dbStatus.error || 'Unable to connect to database host.'
  });
});
