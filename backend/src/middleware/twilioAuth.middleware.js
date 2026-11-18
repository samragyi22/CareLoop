import twilio from 'twilio';
import proxyaddr from 'proxy-addr';
import { env } from '../config/env.js';

/**
 * Checks whether the incoming connection originates from a trusted reverse proxy
 * configured in Express via `trust proxy`.
 */
export function isTrustedProxy(req) {
  const trustSetting = req.app?.get('trust proxy');
  if (!trustSetting || trustSetting === false) return false;

  const trustFn = typeof trustSetting === 'function'
    ? trustSetting
    : proxyaddr.compile(trustSetting);

  const remoteIp = req.socket?.remoteAddress;
  return remoteIp ? Boolean(trustFn(remoteIp, 0)) : false;
}

/**
 * Reconstructs the exact public URL used by Twilio to sign the webhook request.
 * 
 * Order of Precedence:
 * 1. Authoritative configured public webhook base URL (PUBLIC_URL).
 *    In production & ngrok tunnels, this is explicitly configured in Twilio Console.
 *    Using it prevents untrusted clients from spoofing the Host header via forwarded headers.
 * 2. If PUBLIC_URL is unset or placeholder, forwarded headers (X-Forwarded-Proto / X-Forwarded-Host)
 *    are trusted ONLY IF the request is verified to originate from a trusted proxy (e.g., loopback/ALB/Nginx).
 * 3. Fallback to direct connection protocol and host (req.protocol + req.headers.host).
 * 
 * Always preserves the exact originalUrl including path and query string parameters.
 */
export function reconstructTwilioUrl(req) {
  // 1. Only trust forwarded headers from verified trusted proxies (e.g. ngrok / ALB / Nginx)
  if (isTrustedProxy(req)) {
    const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || req.protocol;
    const forwardedHost = req.headers['x-forwarded-host']?.split(',')[0].trim();
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}${req.originalUrl}`;
    }
  }

  // 2. Direct connection socket protocol and host (e.g. local automated tests to 127.0.0.1:5000)
  const isDirectLoopback = (req.headers.host?.includes('127.0.0.1') || req.headers.host?.includes('localhost'));
  if (isDirectLoopback) {
    const proto = req.protocol || 'http';
    const host = req.headers.host || `localhost:${env.PORT}`;
    return `${proto}://${host}${req.originalUrl}`;
  }

  // 3. Explicitly configured public webhook URL has priority for external traffic
  const configuredBase = env.PUBLIC_URL?.replace(/\/+$/, '');
  if (configuredBase && !configuredBase.includes('your-tunnel-subdomain')) {
    return `${configuredBase}${req.originalUrl}`;
  }

  // 4. Fallback to direct socket connection details
  const proto = req.protocol || 'http';
  const host = req.headers.host || `localhost:${env.PORT}`;
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Middleware to verify Twilio webhook signatures.
 * Strictly verifies the HMAC-SHA1 signature using the configured Twilio Auth Token.
 */
export function verifyTwilioWebhook(req, res, next) {
  // If explicitly configured for mock simulation mode without telephony (never in production)
  if (env.VOICE_MOCK_MODE && env.NODE_ENV !== 'production') {
    req.isTwilioMock = true;
    return next();
  }

  const signature = req.headers['x-twilio-signature'];

  if (!signature) {
    console.warn(`[Twilio Auth] Missing X-Twilio-Signature on ${req.method} ${req.originalUrl}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Missing required Twilio webhook signature header.',
      code: 'TWILIO_SIGNATURE_MISSING'
    });
  }

  if (!env.TWILIO_AUTH_TOKEN) {
    console.error('[Twilio Auth] TWILIO_AUTH_TOKEN is not configured.');
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Twilio authentication is not configured on this server.',
      code: 'TWILIO_AUTH_UNCONFIGURED'
    });
  }

  const fullUrl = reconstructTwilioUrl(req);
  const isValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    fullUrl,
    req.body || {}
  );

  if (!isValid) {
    console.warn(`[Twilio Auth] Invalid signature rejected. URL: ${fullUrl}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Twilio webhook signature verification failed.',
      code: 'TWILIO_SIGNATURE_INVALID'
    });
  }

  req.isTwilioMock = false;
  next();
}
