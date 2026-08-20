export default {
  migrationId: "0005_baseline",
  fromSchema: 5,
  toSchema: 5,
  acceptedPreFingerprints: [
    // Existing production schema built through the historical incremental path.
    "0052249f7561ceb2d4857d4133a71fbba6129ae3c2a63b14519fbbc27d414e67",
    // Fresh schema 5 created by the current application initializer.
    "fd9dc94af5737ef0e0a95a4f71de89e046321154ffd772b83e57e065be8f0a0a",
  ],
  sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      from_schema INTEGER NOT NULL,
      to_schema INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      before_fingerprint TEXT NOT NULL CHECK (length(before_fingerprint) = 64),
      after_fingerprint TEXT NOT NULL CHECK (length(after_fingerprint) = 64),
      verification_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migration_attempts (
      attempt_id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      from_schema INTEGER NOT NULL,
      to_schema INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'unknown')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      before_fingerprint TEXT NOT NULL CHECK (length(before_fingerprint) = 64),
      after_fingerprint TEXT CHECK (after_fingerprint IS NULL OR length(after_fingerprint) = 64),
      verification_json TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS ix_migration_attempts_migration_time
      ON migration_attempts(migration_id, started_at DESC);

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
      BEFORE UPDATE ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
      BEFORE DELETE ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS migration_attempts_success_no_update
      BEFORE UPDATE ON migration_attempts
      WHEN OLD.status = 'success'
      BEGIN SELECT RAISE(ABORT, 'successful migration attempt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS migration_attempts_no_delete
      BEFORE DELETE ON migration_attempts
      BEGIN SELECT RAISE(ABORT, 'migration_attempts is append-only'); END;
  `,
};
