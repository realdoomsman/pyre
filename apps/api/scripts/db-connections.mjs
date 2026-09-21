/**
 * Ops probe: who is holding Postgres connections, and how close are we to
 * max_connections. Run when anything reports "too many clients already".
 *
 * Usage (inside the api container, cwd /repo):
 *   node apps/api/scripts/db-connections.mjs
 */
import { prisma } from "@pyre/db";

const rows = await prisma.$queryRawUnsafe(`
  SELECT state, count(*)::int AS connections
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
  ORDER BY connections DESC
`);
const [{ max_connections }] = await prisma.$queryRawUnsafe(`SHOW max_connections`);
const [{ total }] = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database()`,
);
const idle = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS stale
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND state = 'idle'
    AND state_change < now() - interval '5 minutes'
`);

console.log(
  JSON.stringify(
    { maxConnections: Number(max_connections), total, byState: rows, staleIdleOver5m: idle[0]?.stale ?? 0 },
    null,
    2,
  ),
);

await prisma.$disconnect();
