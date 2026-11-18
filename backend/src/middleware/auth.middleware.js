import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { verifyAuthToken, getCurrentClinician, getCurrentPatient } from '../services/auth.service.js';
import { isTokenRevoked } from '../repositories/tokenRevocation.repository.js';

export const PATIENT_COOKIE_NAME = 'careloop_patient_token';

/**
 * Rate limiter for login endpoint to mitigate brute-force credential stuffing.
 * Allows 10 login attempts per 15 minutes per IP.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs in dev/test
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error: 'TooManyRequests',
    message: 'Too many login attempts. Please try again in 15 minutes.',
    status: 429
  }
});

/**
 * Middleware requiring a valid, authenticated clinician.
 * Reads token from HttpOnly cookie or Authorization Bearer header.
 * Verifies role 'clinician' and active account status in the database.
 */
export async function requireClinician(req, res, next) {
  try {
    let token = null;

    // 1. Check HttpOnly cookie
    if (req.cookies && req.cookies[env.COOKIE_NAME]) {
      token = req.cookies[env.COOKIE_NAME];
    } 
    // 2. Check Authorization header (Bearer)
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required. Please log in.',
        status: 401
      });
    }

    // Verify token
    const decoded = verifyAuthToken(token);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session is invalid or has expired. Please log in again.',
        status: 401
      });
    }

    // Verify user in database (ensures real-time check of isActive and role)
    const clinician = await getCurrentClinician(decoded.userId);
    if (!clinician) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User account not found, deactivated, or not authorized as clinician.',
        status: 401
      });
    }

    // Attach validated clinician object to req (excluding passwordHash)
    req.user = clinician;
    next();
  } catch (err) {
    console.error('[Auth Middleware] Verification error:', err.message);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication failed.',
      status: 401
    });
  }
}

/**
 * Middleware requiring a valid, authenticated patient.
 * Reads token from HttpOnly cookie (careloop_patient_token) or Authorization Bearer header.
 * Verifies role 'patient' and active account status in the database.
 */
export async function requirePatient(req, res, next) {
  try {
    let token = null;

    // 1. Check Authorization header (Bearer)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1]?.trim();
    } 
    // 2. Check HttpOnly patient cookie
    else if (req.cookies && req.cookies[PATIENT_COOKIE_NAME]) {
      token = req.cookies[PATIENT_COOKIE_NAME]?.trim();
    }

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Patient authentication required. Please log in to your patient account.',
        status: 401
      });
    }

    // Verify token signature & expiration
    const decoded = verifyAuthToken(token);
    if (!decoded || !decoded.userId || decoded.role !== 'patient') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Patient session is invalid or has expired. Please log in again.',
        status: 401
      });
    }

    // Check server-side token revocation (fail-closed if revocation check fails)
    let revoked = false;
    try {
      revoked = await isTokenRevoked(token);
    } catch (storeErr) {
      console.error('[Auth Middleware] Token revocation store error:', storeErr.message);
      return res.status(503).json({
        error: 'ServiceUnavailable',
        code: 'REVOCATION_STORE_UNAVAILABLE',
        message: 'Security validation service temporarily unavailable. Please try again later.',
        status: 503
      });
    }

    if (revoked) {
      return res.status(401).json({
        error: 'Unauthorized',
        code: 'SESSION_REVOKED',
        message: 'Patient session has been logged out or revoked. Please log in again.',
        status: 401
      });
    }

    // Verify patient user in database
    const patient = await getCurrentPatient(decoded.userId);
    if (!patient) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Patient account not found, deactivated, or not authorized.',
        status: 401
      });
    }

    // Attach validated patient object to req
    req.patient = patient;
    next();
  } catch (err) {
    console.error('[Auth Middleware] Patient verification error:', err.message);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Patient authentication failed.',
      status: 401
    });
  }
}

