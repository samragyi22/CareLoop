import { MongoClient } from 'mongodb';
import { execSync } from 'child_process';
import { env } from './env.js';

let client = null;
let db = null;
let connectionStatus = 'unconfigured';
let lastError = null;
let retryTimer = null;

// A distant database costs several round trips to open each connection, so keep a few open and
// ready: parallel queries on a live phone call then take one round trip instead of several seconds.
// The timeouts leave room for that distance: the first connection takes about 6 seconds from here,
// so a 5 second limit failed whenever the network was a little slow.
const POOL_OPTIONS = {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 10000,
  minPoolSize: 10,
  maxConnecting: 5
};

/**
 * Resolves MongoDB SRV URI using Windows OS DNS when Node c-ares hits ECONNREFUSED.
 */
function resolveSrvOnWindows(srvUri) {
  try {
    const match = srvUri.match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)(.*)$/);
    if (!match) return null;

    const [, auth, host, rest] = match;
    console.log(`[MongoDB] Resolving SRV for ${host} using Windows OS DNS fallback...`);

    const srvCmd = `powershell -NoProfile -Command "(Resolve-DnsName -Name _mongodb._tcp.${host} -Type SRV).NameTarget"`;
    const srvOut = execSync(srvCmd, { encoding: 'utf8' }).trim();
    const shards = srvOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (shards.length === 0) return null;

    const shardList = shards.map(s => `${s}:27017`).join(',');

    const txtCmd = `powershell -NoProfile -Command "(Resolve-DnsName -Name ${host} -Type TXT).Strings"`;
    const txtOut = execSync(txtCmd, { encoding: 'utf8' }).trim().replace(/\r?\n/g, '&');

    const cleanRest = rest.startsWith('/') ? rest.slice(1) : rest;
    const dbName = cleanRest.split('?')[0] || env.MONGODB_DB_NAME || 'careloop';

    const fallbackUri = `mongodb://${auth}@${shardList}/${dbName}?ssl=true&${txtOut}&retryWrites=true&w=majority`;
    return fallbackUri;
  } catch (err) {
    console.warn(`[MongoDB] Windows DNS fallback failed: ${err.message}`);
    return null;
  }
}

/**
 * Connect to MongoDB using the official Node.js driver.
 * Will not terminate the process if connection fails or if MONGODB_URI is not set.
 */
export async function connectDb() {
  if (!env.MONGODB_URI) {
    connectionStatus = 'unconfigured';
    console.warn('[MongoDB] MONGODB_URI is not set. Starting in unconfigured mode (API functional, DB disconnected).');
    return null;
  }

  try {
    console.log('[MongoDB] Attempting connection...');
    connectionStatus = 'connecting';
    let targetUri = env.MONGODB_URI;

    try {
      client = new MongoClient(targetUri, POOL_OPTIONS);
      await client.connect();
    } catch (primaryErr) {
      // If SRV lookup fails with ECONNREFUSED (common on Windows), try Windows DNS fallback
      if (
        primaryErr.message && 
        primaryErr.message.includes('querySrv ECONNREFUSED') && 
        targetUri.startsWith('mongodb+srv://')
      ) {
        console.warn('[MongoDB] Direct SRV query failed with ECONNREFUSED. Attempting OS-level DNS resolution...');
        const resolvedUri = resolveSrvOnWindows(targetUri);
        if (resolvedUri) {
          if (client) {
            try { await client.close(); } catch (_) {}
          }
          client = new MongoClient(resolvedUri, POOL_OPTIONS);
          await client.connect();
        } else {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }

    db = client.db(env.MONGODB_DB_NAME);

    // Verify connection by pinging
    await db.command({ ping: 1 });

    connectionStatus = 'connected';
    lastError = null;
    console.log(`[MongoDB] Successfully connected to database: "${env.MONGODB_DB_NAME}"`);
    return db;
  } catch (err) {
    connectionStatus = 'disconnected';
    lastError = err.message;
    console.error(`[MongoDB] Connection failed: ${err.message}`);
    if (client) {
      try {
        await client.close();
      } catch (closeErr) {
        // ignore close errors
      }
      client = null;
      db = null;
    }
    return null;
  }
}

/**
 * Connects in the background and keeps trying until the database answers. A momentary network or DNS
 * hiccup while starting (for example "querySrv ETIMEOUT") must not leave the server without a
 * database until someone restarts it. Calls onConnected(db) once, when the connection is up.
 */
export async function connectDbInBackground(onConnected) {
  retryTimer = null;
  let attempt = 0;
  const tryConnect = async () => {
    retryTimer = null;
    attempt += 1;
    const connected = await connectDb();
    if (connected) {
      if (attempt > 1) console.log(`[MongoDB] Connected after ${attempt} attempts.`);
      onConnected?.(connected);
      return;
    }
    if (connectionStatus === 'unconfigured') return;
    const delayMs = Math.min(attempt * 2000, 10000);
    console.warn(`[MongoDB] Will try again in ${delayMs / 1000}s. Requests get "database still connecting" until then.`);
    retryTimer = setTimeout(tryConnect, delayMs);
  };
  await tryConnect();
}

/**
 * Returns the active MongoDB database instance, or null if not connected.
 */
export function getDb() {
  return db;
}

/**
 * Returns the underlying MongoClient instance for session and transaction support.
 */
export function getClient() {
  return client;
}

/**
 * Returns structured database status.
 */
export function getDbStatus() {
  return {
    status: connectionStatus,
    database: env.MONGODB_DB_NAME,
    isConfigured: Boolean(env.MONGODB_URI),
    error: lastError
  };
}

/**
 * Gracefully close the MongoDB client connection.
 */
export async function closeDb() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (client) {
    await client.close();
    connectionStatus = 'disconnected';
    client = null;
    db = null;
    console.log('[MongoDB] Connection closed.');
  }
}
