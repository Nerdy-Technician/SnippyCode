/**
 * Import first in test files that also import src modules at the top: the
 * database connection is created when src/db is first loaded, so the test
 * database has to be in DATABASE_URL before that.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

export {};
