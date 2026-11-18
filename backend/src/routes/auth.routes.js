import express from 'express';
import { env } from '../config/env.js';
import { authenticateClinician, authenticatePatient, verifyAuthToken } from '../services/auth.service.js';
import { requireClinician, requirePatient, loginRateLimiter, PATIENT_COOKIE_NAME } from '../middleware/auth.middleware.js';
import { revokeToken } from '../repositories/tokenRevocation.repository.js';

export const authRouter = express.Router();

/**
 * Cookie options helper.
 */
function getCookieOptions() {
  const isProduction = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/'
  };
}

/**
 * POST /api/auth/login
 * Authenticates clinician credentials and sets HttpOnly session cookie.
 */
authRouter.post('/login', loginRateLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Email and password are required.',
        status: 400
      });
    }

    const { user, token } = await authenticateClinician(email, password);

    // Set secure HttpOnly cookie
    res.cookie(env.COOKIE_NAME, token, getCookieOptions());

    res.status(200).json({
      status: 'success',
      message: 'Authentication successful.',
      user
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: err.name || 'AuthenticationError',
      message: err.message || 'Authentication failed.',
      status: statusCode
    });
  }
});

/**
 * POST /api/auth/logout
 * Clears the session cookie and invalidates the client session.
 */
authRouter.post('/logout', (req, res) => {
  res.clearCookie(env.COOKIE_NAME, getCookieOptions());
  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully.'
  });
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated clinician's profile.
 */
authRouter.get('/me', requireClinician, (req, res) => {
  res.status(200).json({
    status: 'success',
    user: req.user
  });
});

/**
 * POST /api/auth/patient/login
 * Authenticates patient credentials and sets HttpOnly patient session cookie.
 */
authRouter.post('/patient/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Email and password are required.',
        status: 400
      });
    }

    const { user, token } = await authenticatePatient(email, password);

    // Set secure HttpOnly patient cookie
    res.cookie(PATIENT_COOKIE_NAME, token, getCookieOptions());

    res.status(200).json({
      status: 'success',
      message: 'Patient authentication successful.',
      patient: user,
      token // Return token as well for testing or bearer token fallback
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: err.name || 'AuthenticationError',
      message: err.message || 'Patient authentication failed.',
      status: statusCode
    });
  }
});

/**
 * POST /api/auth/patient/logout
 * Clears the patient session cookie.
 */
authRouter.post('/patient/logout', async (req, res) => {
  try {
    const tokensToRevoke = new Set();

    // 1. Check Authorization header (Bearer)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const headerToken = req.headers.authorization.split(' ')[1]?.trim();
      if (headerToken) tokensToRevoke.add(headerToken);
    }

    // 2. Check HttpOnly patient cookie
    if (req.cookies && req.cookies[PATIENT_COOKIE_NAME]) {
      const cookieToken = req.cookies[PATIENT_COOKIE_NAME]?.trim();
      if (cookieToken) tokensToRevoke.add(cookieToken);
    }

    // Revoke all patient tokens associated with this logout invocation
    for (const token of tokensToRevoke) {
      const decoded = verifyAuthToken(token);
      await revokeToken(token, {
        userId: decoded?.userId || null,
        expiresAt: decoded?.exp || null,
        reason: 'patient_logout'
      });
    }

    res.clearCookie(PATIENT_COOKIE_NAME, getCookieOptions());
    return res.status(200).json({
      status: 'success',
      message: 'Patient logged out and session revoked successfully.'
    });
  } catch (err) {
    res.clearCookie(PATIENT_COOKIE_NAME, getCookieOptions());
    return res.status(200).json({
      status: 'success',
      message: 'Patient logged out successfully.'
    });
  }
});

/**
 * GET /api/auth/patient/me
 * Returns the currently authenticated patient's profile.
 */
authRouter.get('/patient/me', requirePatient, (req, res) => {
  res.status(200).json({
    status: 'success',
    patient: req.patient
  });
});

