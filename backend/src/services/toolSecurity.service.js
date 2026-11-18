import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Tool Security Service
 * 
 * Protects voice agent tool endpoints from arbitrary public requests,
 * forged execution attempts, and unauthorized invocation.
 */

/**
 * Generates a session-bound HMAC-SHA256 authentication token for tool calls.
 */
export function generateToolToken(callSid) {
  if (!callSid || typeof callSid !== 'string') {
    throw new Error('callSid is required to generate a tool token');
  }
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`careloop-tool:${callSid.trim()}`)
    .digest('hex');
}

/**
 * Validates that a tool token was generated for the given callSid.
 */
export function verifyToolToken(token, callSid) {
  if (!token || !callSid || typeof token !== 'string' || typeof callSid !== 'string') {
    return false;
  }
  const expected = generateToolToken(callSid);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

/**
 * Express middleware to authenticate tool webhook invocations from Ultravox.
 */
export function requireToolAuth(req, res, next) {
  // Allow unauthenticated simulated execution only in non-production mock mode
  const mockBypassAllowed = env.VOICE_MOCK_MODE && env.NODE_ENV !== 'production';
  if (mockBypassAllowed && (req.headers['x-mock-tool'] === 'true' || req.body?.isMock === true)) {
    req.isMockTool = true;
    return next();
  }

  // Token can be passed via custom header or static body parameter
  const token = req.headers['x-careloop-tool-token'] || req.body?.toolToken || req.query?.toolToken;
  const callSid = req.body?.callSid || req.query?.callSid || req.headers['x-call-sid'];

  if (!token || !callSid) {
    console.warn(`[Tool Auth] Missing token or callSid on ${req.method} ${req.originalUrl}`);
    return res.status(403).json({
      status: 'unauthorized',
      error: 'Forbidden',
      message: 'Missing required tool authentication credentials or call session binding.',
      code: 'TOOL_AUTH_MISSING'
    });
  }

  if (!verifyToolToken(token, callSid)) {
    console.warn(`[Tool Auth] Invalid tool token for callSid: ${callSid}`);
    return res.status(403).json({
      status: 'unauthorized',
      error: 'Forbidden',
      message: 'Invalid or forged tool authentication token.',
      code: 'TOOL_AUTH_INVALID'
    });
  }

  req.callSid = callSid;
  req.isMockTool = false;
  next();
}
