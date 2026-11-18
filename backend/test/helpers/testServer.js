import { once } from 'events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { app } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { connectDb, closeDb, getDb } from '../../src/config/db.js';
import { initAllIndexes } from '../../src/config/indexes.js';

/**
 * Starts an isolated in-memory MongoDB replica set (transactions need one) and the Express app
 * on a random port. Configuration is applied to the shared `env` object, which the app reads at
 * call time. Each test file runs in its own process, so tests never share a database.
 */
export async function startTestServer({ envOverrides = {} } = {}) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  Object.assign(env, {
    NODE_ENV: 'test',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB_NAME: 'careloop_test',
    JWT_SECRET: 'test-only-secret-value-that-is-at-least-32-chars',
    VOICE_MOCK_MODE: true,
    ...envOverrides
  });
  process.env.NODE_ENV = 'test';

  await connectDb();
  await initAllIndexes();

  const server = app.listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    env,
    getDb,
    async stop() {
      await new Promise(resolve => server.close(resolve));
      await closeDb();
      await replSet.stop();
    }
  };
}

/**
 * Minimal JSON HTTP client that keeps cookies, so tests can log in like a browser.
 */
export function createClient(baseUrl) {
  const cookies = new Map();

  async function request(method, path, { body, headers = {} } = {}) {
    const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value) cookies.set(name.trim(), value);
      else cookies.delete(name.trim());
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: res.status, data };
  }

  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    del: (path, opts) => request('DELETE', path, opts)
  };
}
