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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tasks

CREATE TABLE IF NOT EXISTS tasks (
    task_id        TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    progress       REAL NOT NULL DEFAULT 0,
    input_file_id  TEXT REFERENCES files(file_id),
    settings       JSONB NOT NULL DEFAULT '{}',
    slot_id        TEXT,
    output_file_id TEXT REFERENCES files(file_id),
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
    input_file_id TEXT REFERENCES files(file_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction table linking a conversion to its constituent tasks

CREATE TABLE IF NOT EXISTS conversion_tasks (
    conversion_id TEXT NOT NULL REFERENCES conversions(conversion_id) ON DELETE CASCADE,
    task_id       TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY (conversion_id, task_id)
);
