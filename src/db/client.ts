import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

export type Db = MySql2Database<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: mysql.Pool } {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    // Return DECIMAL as a string so money never round-trips through a float.
    decimalNumbers: false,
  });
  return { db: drizzle(pool, { schema, mode: 'default' }), pool };
}
