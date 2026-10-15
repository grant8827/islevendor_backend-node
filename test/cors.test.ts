import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './helpers.js';

// CORS_ORIGIN is a comma-separated list (setup-env.mjs uses the local web app;
// production lists both the Railway address and islevendor.com).
describe('allowed websites (CORS)', () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => server.close());

  const preflight = (origin: string) =>
    fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });

  it('allows a listed website and refuses others', async () => {
    const allowed = await preflight('http://localhost:5173');
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const other = await preflight('https://evil.example.com');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});

describe('allowed websites (CORS), second entry', () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => server.close());

  it('allows every website in the list, ignoring spaces and a trailing slash', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://islevendor.test', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://islevendor.test');
  });
});
