import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Lazy connection — DATABASE_URL isn't available during Next.js build-time
// static analysis (only at runtime, once a route actually executes), so
// throwing at module load broke the build. The Proxy defers the real
// connection (and the "is it set" check) until a route first touches `db`.
// Explicitly parameterized with the schema generic — plain `ReturnType<typeof
// drizzle>` (no <typeof schema>) compiles fine for .select()/.insert() but
// silently loses the schema-aware `db.query.*` relational API, since that
// surface only exists on the schema-instantiated overload.
type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleDB | null = null;

function getDb(): DrizzleDB {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}

export const db = new Proxy({} as DrizzleDB, {
  get(_, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getDb() as any)[prop];
  },
});

export * from "./schema";
