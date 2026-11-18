import { ObjectId } from 'mongodb';

/**
 * Converts a string or ObjectId to an ObjectId. Returns null for anything malformed.
 */
export function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)) {
    return new ObjectId(id);
  }
  return null;
}

export function isoOrNull(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}
