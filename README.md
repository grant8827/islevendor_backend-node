# Node backend

Setup and run:

1. Install dependencies:

```bash
cd backend-node
npm install
```

2. Run in development mode (auto-reload):

```bash
npm run dev
```

3. Run production:

```bash
npm start
```

## Tests

Integration tests boot the real app against a local, throwaway Postgres
(PostGIS) database and Redis. They refuse to run against anything that isn't
on localhost and named `*_test`, and never read `DATABASE_URL` from `.env`.

```sh
createdb islevendor_test && psql -d islevendor_test -c 'CREATE EXTENSION IF NOT EXISTS postgis'
npm run test:db:prepare   # applies prisma/migrations to the test database
npm test
npm run typecheck
```

Set `TEST_DATABASE_URL` / `TEST_REDIS_URL` to override the defaults in
`test/setup-env.mjs`.
