import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { findUserByEmail, findUserById } from '../repositories/user.repository.js';

const SALT_ROUNDS = 10;

/**
 * Hashes a plaintext password using bcrypt.
 */
export async function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compares a plaintext password with a stored bcrypt hash.
 */
export async function comparePassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * Generates a signed JWT token for the authenticated user.
 */
export function generateAuthToken(user) {
  const payload = {
    userId: String(user._id),
    email: user.email,
    role: user.role,
    name: user.name,
    phone: user.phone || null
  };

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN
  });
}

/**
 * Verifies a JWT token. Returns decoded payload or null if invalid/expired.
 */
export function verifyAuthToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Authenticates clinician credentials.
 * Throws errors with generic messages for security.
 */
export async function authenticateClinician(email, password) {
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    const error = new Error('Invalid email or password');
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Basic email pattern check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  // Lookup user with passwordHash
  const user = await findUserByEmail(normalizedEmail, { includePassword: true });
  if (!user) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  // Verify account is active
  if (!user.isActive) {
    const error = new Error('Account is inactive. Please contact administration.');
    error.statusCode = 403;
    throw error;
  }

  // Verify password
  const isValid = await comparePassword(password, user.passwordHash);
  if (!isValid) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  // Ensure role is strictly clinician
  if (user.role !== 'clinician') {
    const error = new Error('Unauthorized role for clinician workspace');
    error.statusCode = 403;
    throw error;
  }

  // Generate token and return sanitized user
  const token = generateAuthToken(user);
  const { passwordHash, ...sanitizedUser } = user;

  return {
    user: sanitizedUser,
    token
  };
}

/**
 * Resolves current user from valid JWT payload.
 */
export async function getCurrentClinician(userId) {
  const user = await findUserById(userId);
  if (!user || !user.isActive || user.role !== 'clinician') {
    return null;
  }
  return user;
}

/**
 * Authenticates patient credentials.
 * Rejects clinician accounts to enforce role boundary.
 */
export async function authenticatePatient(email, password) {
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    const error = new Error('Invalid email or password');
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  const user = await findUserByEmail(normalizedEmail, { includePassword: true });
  if (!user) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  if (!user.isActive) {
    const error = new Error('Account is inactive. Please contact clinic reception.');
    error.statusCode = 403;
    throw error;
  }

  const isValid = await comparePassword(password, user.passwordHash);
  if (!isValid) {
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  if (user.role !== 'patient') {
    const error = new Error('Unauthorized role for patient portal');
    error.statusCode = 403;
    throw error;
  }

  const token = generateAuthToken(user);
  const { passwordHash, ...sanitizedUser } = user;

  return {
    user: sanitizedUser,
    token
  };
}

/**
 * Resolves current patient from valid JWT payload.
 */
export async function getCurrentPatient(userId) {
  const user = await findUserById(userId);
  if (!user || !user.isActive || user.role !== 'patient') {
    return null;
  }
  return user;
}

