import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend root if present
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// Secrets that are public (in this repo) and must never protect a production deployment
const DEV_JWT_SECRET = 'careloop-development-jwt-secret-do-not-use-in-production-random-key';
const KNOWN_PLACEHOLDER_SECRETS = [DEV_JWT_SECRET, 'your-secure-random-jwt-secret-key-min-32-chars'];

const DEPLOYMENT_REGION = (process.env.DEPLOYMENT_REGION || 'IN').toUpperCase().trim();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  MONGODB_URI: process.env.MONGODB_URI ? process.env.MONGODB_URI.trim() : '',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'careloop',

  // Auth Configuration
  JWT_SECRET: process.env.JWT_SECRET || DEV_JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
  COOKIE_NAME: 'careloop_token',

  // Seeding credentials (development only)
  SEED_CLINICIAN_NAME: process.env.SEED_CLINICIAN_NAME || 'Dr. Kavita Rao',
  SEED_CLINICIAN_EMAIL: process.env.SEED_CLINICIAN_EMAIL || 'clinician@careloop.local',
  SEED_CLINICIAN_PASSWORD: process.env.SEED_CLINICIAN_PASSWORD || 'CareLoop2026!',

  // Appointment Configuration
  DEFAULT_SLOT_DURATION_MINUTES: parseInt(process.env.DEFAULT_SLOT_DURATION_MINUTES || '30', 10),
  // Clinic-local timezone used for schedules and spoken times (India deployments default to IST)
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || (DEPLOYMENT_REGION === 'IN' ? 'Asia/Kolkata' : 'UTC'),

  // Telephony (Twilio) Configuration
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.trim() : '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? process.env.TWILIO_AUTH_TOKEN.trim() : '',
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? process.env.TWILIO_PHONE_NUMBER.trim() : '',
  PUBLIC_URL: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.trim() : '',

  // Voice Agent (Ultravox) Configuration
  ULTRAVOX_API_KEY: process.env.ULTRAVOX_API_KEY ? process.env.ULTRAVOX_API_KEY.trim() : '',
  ULTRAVOX_MODEL: process.env.ULTRAVOX_MODEL || 'ultravox-v0.7',
  ULTRAVOX_VOICE: process.env.ULTRAVOX_VOICE || 'Riya',
  ULTRAVOX_LANGUAGE_HINT: process.env.ULTRAVOX_LANGUAGE_HINT || 'hi',
  VOICE_MOCK_MODE: process.env.VOICE_MOCK_MODE === 'true' || process.env.VOICE_MOCK_MODE === '1',

  // Regional Safety Configuration (Default: IN -> 112)
  DEPLOYMENT_REGION,
  EMERGENCY_NUMBER: process.env.EMERGENCY_NUMBER ? process.env.EMERGENCY_NUMBER.trim() : '',

  // Express Reverse Proxy / Forwarded Header Trust Configuration
  TRUST_PROXY: process.env.TRUST_PROXY ? process.env.TRUST_PROXY.trim() : 'loopback',

  // Clinic Facility Configuration (Standardized)
  CLINIC_FACILITY_NAME: process.env.CLINIC_FACILITY_NAME ? process.env.CLINIC_FACILITY_NAME.trim() : '',
  CLINIC_ADDRESS: process.env.CLINIC_ADDRESS ? process.env.CLINIC_ADDRESS.trim() : '',
  CLINIC_SUITE: process.env.CLINIC_SUITE ? process.env.CLINIC_SUITE.trim() : '',
  CLINIC_CHECK_IN_DESK: process.env.CLINIC_CHECK_IN_DESK ? process.env.CLINIC_CHECK_IN_DESK.trim() : '',
  CLINIC_PHONE: (process.env.CLINIC_PHONE || process.env.CLINIC_CONTACT_PHONE || '').trim(),
  CLINIC_EMAIL: process.env.CLINIC_EMAIL ? process.env.CLINIC_EMAIL.trim() : '',
  CLINIC_HOURS: process.env.CLINIC_HOURS ? process.env.CLINIC_HOURS.trim() : 'Monday – Friday, 8:00 AM – 5:30 PM',

  // Missed-Call Callback (Milestone M8.1) Configuration
  // Disabled by default until explicitly enabled
  VOICE_CALLBACK_ENABLED: process.env.VOICE_CALLBACK_ENABLED === 'true' || process.env.VOICE_CALLBACK_ENABLED === '1',
  VOICE_CALLBACK_COOLDOWN_SECONDS: parseInt(process.env.VOICE_CALLBACK_COOLDOWN_SECONDS || '300', 10),
  VOICE_CALLBACK_MAX_ATTEMPTS: parseInt(process.env.VOICE_CALLBACK_MAX_ATTEMPTS || '3', 10),
  VOICE_CALLBACK_REQUIRE_CONSENT: process.env.VOICE_CALLBACK_REQUIRE_CONSENT !== 'false',

  // PlanPilot agent. Without an LLM it decides with built-in rules; with one, the LLM picks from the
  // same server-built list of allowed actions and the rules are the fallback.
  PLANPILOT_LLM_PROVIDER: (process.env.PLANPILOT_LLM_PROVIDER || 'none').trim().toLowerCase(),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '',
  PLANPILOT_LLM_MODEL: process.env.PLANPILOT_LLM_MODEL || 'gemini-2.5-flash',
  PLANPILOT_LLM_BASE_URL: process.env.PLANPILOT_LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  PLANPILOT_LLM_TIMEOUT_MS: parseInt(process.env.PLANPILOT_LLM_TIMEOUT_MS || '10000', 10),
  // Phone the patient automatically whenever an option is waiting for their answer
  PLANPILOT_AUTO_CALL_PATIENTS: process.env.PLANPILOT_AUTO_CALL_PATIENTS !== 'false',
  // Re-evaluate every active plan this often (0 = off; use the "Run PlanPilot agent" button instead)
  PLANPILOT_AGENT_INTERVAL_MINUTES: parseInt(process.env.PLANPILOT_AGENT_INTERVAL_MINUTES || '0', 10)
};

/**
 * Throws if a production deployment is configured with values that would let anyone
 * forge sessions or tool calls, or that would silently fake telephony.
 */
export function assertProductionSafety(config = env) {
  if (config.NODE_ENV !== 'production') return;

  const problems = [];
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32 || KNOWN_PLACEHOLDER_SECRETS.includes(config.JWT_SECRET)) {
    problems.push('JWT_SECRET must be set to a private random value of at least 32 characters.');
  }
  if (config.VOICE_MOCK_MODE) {
    problems.push('VOICE_MOCK_MODE must be disabled in production.');
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe production configuration: ${problems.join(' ')}`);
  }
}

