import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// Pooled, direct connection.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// No `schema` passed: we use the core query builder with imported table objects.
// Better Auth's drizzle adapter gets its tables via its own `schema` option.
export const db = drizzle(pool);
