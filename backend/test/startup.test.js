import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'events';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

/**
 * While the database is still connecting (just after start-up, or after a network hiccup), the API
 * must say so plainly. It used to answer a login with "Invalid email or password", which sent people
 * hunting for a wrong password when the real problem was a database that had not connected.
 * Nothing here ever connects to a database.
 */
test('API says the database is still connecting, instead of failing per route', async (t) => {
  // Any value makes the app treat the database as configured; it is never contacted in this test
  env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-connected';
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body) => fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });

  const health = await send('GET', '/api/health');
  assert.equal(health.status, 200, 'the server itself is reachable');

  const dbHealth = await send('GET', '/api/health/db');
  assert.equal((await dbHealth.json()).service, 'MongoDB', 'the database health check answers for itself');

  const login = await send('POST', '/api/auth/login', { email: 'clinician@careloop.local', password: 'whatever-it-is' });
  assert.equal(login.status, 503, 'a login must not claim the password is wrong');
  const loginBody = await login.json();
  assert.equal(loginBody.code, 'DB_CONNECTING');
  assert.match(loginBody.message, /database is still connecting/i);
  assert.equal(login.headers.get('retry-after'), '3');

  const session = await send('GET', '/api/auth/me');
  assert.equal(session.status, 503);
  assert.equal((await session.json()).code, 'DB_CONNECTING');

  const tool = await send('POST', '/api/voice/tools/check_symptoms', {});
  assert.equal(tool.status, 503, 'the phone assistant is told to retry, not given an empty answer');

  const logout = await send('POST', '/api/auth/logout');
  assert.equal(logout.status, 200, 'logging out needs no database');
});
