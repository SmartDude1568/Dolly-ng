-- Dolly database schema
-- Auth tables (already created by the auth route on first run)

CREATE TABLE IF NOT EXISTS users (
    user_id   TEXT PRIMARY KEY,
    email     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Files

CREATE TABLE IF NOT EXISTS files (
    file_id    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type  TEXT NOT NULL,
    local_path TEXT NOT NULL,
    bpm        REAL,
    kind       TEXT NOT NULL DEFAULT 'source',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Detected/confirmed tempo for the song, used to seed the metronome and to
-- drive audio2chart timing. Added after the initial files table shipped.
ALTER TABLE files ADD COLUMN IF NOT EXISTS bpm REAL;

-- Distinguishes uploaded source audio ('source') from generated output
-- artifacts like the packaged .sng ('output'). Only 'source' files are listed
-- as songs / offered as conversion inputs. Added after files shipped.
ALTER TABLE files ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'source';

-- Backfill: any previously-registered .sng outputs were stored as 'source'.
UPDATE files SET kind = 'output' WHERE kind = 'source' AND name LIKE '%.sng';

-- Tasks

CREATE TABLE IF NOT EXISTS tasks (
    task_id        TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    progress       REAL NOT NULL DEFAULT 0,
    input_file_id  TEXT REFERENCES files(file_id) ON DELETE SET NULL,
    settings       JSONB NOT NULL DEFAULT '{}',
    slot_id        TEXT,
    output_file_id TEXT REFERENCES files(file_id) ON DELETE SET NULL,
    error          JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks(user_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx  ON tasks(status);

-- Conversions

CREATE TABLE IF NOT EXISTS conversions (
    conversion_id TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'in_progress',
    input_file_id TEXT REFERENCES files(file_id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction table linking a conversion to its constituent tasks

CREATE TABLE IF NOT EXISTS conversion_tasks (
    conversion_id TEXT NOT NULL REFERENCES conversions(conversion_id) ON DELETE CASCADE,
    task_id       TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY (conversion_id, task_id)
);

-- Relax file foreign keys to ON DELETE SET NULL on already-created databases
-- (the inline definitions above only apply to fresh installs). Without this,
-- deleting a song that any historical task/conversion still references fails
-- with a foreign-key violation. Drop+add is idempotent: each run recreates the
-- same constraint. Detaching keeps the historical rows but clears the link.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_input_file_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_input_file_id_fkey
    FOREIGN KEY (input_file_id) REFERENCES files(file_id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_output_file_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_output_file_id_fkey
    FOREIGN KEY (output_file_id) REFERENCES files(file_id) ON DELETE SET NULL;

ALTER TABLE conversions DROP CONSTRAINT IF EXISTS conversions_input_file_id_fkey;
ALTER TABLE conversions ADD CONSTRAINT conversions_input_file_id_fkey
    FOREIGN KEY (input_file_id) REFERENCES files(file_id) ON DELETE SET NULL;
