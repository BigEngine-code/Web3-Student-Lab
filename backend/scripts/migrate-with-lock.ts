/**
 * CLI entry: `npm run migrate:locked`
 * Same distributed lock the API uses on startup, for operators and CI.
 */
import { runStartupMigrations } from '../src/db/startupMigrations.js';

runStartupMigrations()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
