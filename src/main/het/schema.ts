/**
 * het.db schema (E3.4).
 *
 * Engine: node:sqlite DatabaseSync (TEAM-CONTRACT §2b). Lives in the Lens data dir,
 * separate from Runtime index.db. Never stores full transcripts: only the normalized,
 * redacted, ≤200-char fields of `AgentEvent` (summaries only when `persistSummaries`),
 * task aggregates and provenance (transcript path + line).
 *
 * Semantics carried by the schema:
 *  - minutes are integer TENTHS (`minutes_tenths`) written only by the anchors step
 *    (requires `anchor_version`); the assessor writes kind/complexity/size/agent_share/adoption.
 *    Integer storage makes "weekly total = sum of rows" exact.
 *  - pending / needs_assessment rows have minutes NULL and contribute 0 (T-HET-02).
 *  - corrections are exactly accepted | rejected | not_agent; every change appends het_events.
 */

export const HET_MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS het_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Versioned, user-editable anchors. An edit inserts a NEW version (full row set);
-- old versions are never updated, so historic minutes stay reproducible.
CREATE TABLE IF NOT EXISTS het_anchors (
  version     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('research','writing','coding','review','ops','meeting')),
  unit        TEXT NOT NULL,
  minutes     REAL NOT NULL CHECK (minutes >= 0),
  created_ms  INTEGER NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('default','user')),
  PRIMARY KEY (version, kind)
);
CREATE TRIGGER IF NOT EXISTS het_anchors_immutable BEFORE UPDATE ON het_anchors
BEGIN SELECT RAISE(ABORT, 'het_anchors rows are immutable; insert a new version'); END;
CREATE TRIGGER IF NOT EXISTS het_anchors_nodelete BEFORE DELETE ON het_anchors
BEGIN SELECT RAISE(ABORT, 'het_anchors rows are immutable'); END;

CREATE TABLE IF NOT EXISTS het_tasks (
  id              TEXT PRIMARY KEY,               -- segmenter taskId(), stable across ticks
  agent           TEXT NOT NULL CHECK (agent IN ('claude-code','codex')),
  project         TEXT,
  title           TEXT,                           -- ≤120 chars, redacted; NULL if !persistSummaries
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL CHECK (end_ms >= start_ms),
  status          TEXT NOT NULL DEFAULT 'unsettled' CHECK (status IN
                    ('unsettled','needs_assessment','assessed','failed')),
  kind            TEXT NOT NULL DEFAULT 'unassessed' CHECK (kind IN
                    ('unassessed','research','writing','coding','review','ops','meeting')),
  complexity      TEXT CHECK (complexity IS NULL OR complexity IN ('low','medium','high')),
  size            TEXT CHECK (size IS NULL OR size IN ('xs','s','m','l','xl')),
  agent_share     REAL CHECK (agent_share IS NULL OR (agent_share >= 0 AND agent_share <= 1)),
  adoption        TEXT CHECK (adoption IS NULL OR adoption IN ('strong','weak','unknown')),
  adoption_evidence TEXT,                         -- JSON array of evidence refs (event:/signal:)
  minutes_tenths  INTEGER CHECK (minutes_tenths IS NULL OR minutes_tenths >= 0),
  anchor_version  INTEGER,
  correction      TEXT CHECK (correction IS NULL OR correction IN ('accepted','rejected','not_agent')),
  fingerprint     TEXT NOT NULL,                  -- hash of segment shape; change ⇒ reopen
  session_ids     TEXT NOT NULL,                  -- JSON array
  stats           TEXT NOT NULL,                  -- JSON HetTask.stats
  files_written   TEXT NOT NULL DEFAULT '[]',     -- JSON array of paths (capped)
  signals         TEXT NOT NULL DEFAULT '[]',     -- JSON array of AgentSignal
  attended_ms     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,     -- counted failures (invalid/error) only
  last_attempt_ms INTEGER,
  last_error      TEXT,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL,
  CHECK (minutes_tenths IS NULL OR (status = 'assessed' AND anchor_version IS NOT NULL)),
  FOREIGN KEY (anchor_version, kind) REFERENCES het_anchors(version, kind)
);
CREATE INDEX IF NOT EXISTS idx_het_tasks_start  ON het_tasks(start_ms);
CREATE INDEX IF NOT EXISTS idx_het_tasks_status ON het_tasks(status);

-- Bounded per-task evidence (selected AgentEvents). No transcript content beyond summary.
CREATE TABLE IF NOT EXISTS het_evidence (
  task_id       TEXT NOT NULL REFERENCES het_tasks(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL,                   -- 'ev_' + hash(agent, session, file, line)
  ts_ms         INTEGER NOT NULL,
  role          TEXT NOT NULL,
  tool_names    TEXT NOT NULL DEFAULT '[]',
  files_written TEXT NOT NULL DEFAULT '[]',
  signals       TEXT NOT NULL DEFAULT '[]',
  summary       TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 200),
  source_file   TEXT NOT NULL,
  source_line   INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_id)
);

-- Audit trail.
CREATE TABLE IF NOT EXISTS het_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL,
  at_ms     INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN
              ('segmented','updated','reopened','settled','assessed','needs_assessment','failed',
               'corrected','recomputed','anchors_edited')),
  actor     TEXT NOT NULL CHECK (actor IN ('tick','assessor','user')),
  payload   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_het_events_task ON het_events(task_id, at_ms);

-- Every assessor transport invocation. Caps count rows whose outcome reached a model.
CREATE TABLE IF NOT EXISTS agent_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT,
  at_ms        INTEGER NOT NULL,
  day          TEXT NOT NULL,                     -- local YYYY-MM-DD for the daily cap
  tick_ms      INTEGER NOT NULL,
  transport    TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN
                 ('ok','invalid','quota','offline','budget_unavailable','error')),
  input_chars  INTEGER,
  output_chars INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_calls_day ON agent_calls(day);

CREATE TABLE IF NOT EXISTS het_warnings (
  code        TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  last_ms     INTEGER NOT NULL
);
`
  },
  {
    // X3 / R4-1: provenance of each assessor call. `client` / `model` are the Runtime
    // `[agent_funding]` values the call actually used (as reported by the fixed script);
    // `anchor_version` is the anchors version the verdict was converted with (NULL when no
    // verdict). No prompt, no model text: Lens keeps only verdict / evidence ids / counts.
    version: 2,
    sql: `
ALTER TABLE agent_calls ADD COLUMN client TEXT;
ALTER TABLE agent_calls ADD COLUMN model TEXT;
ALTER TABLE agent_calls ADD COLUMN anchor_version INTEGER;
`
  }
]

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): {
    get(...a: unknown[]): unknown
    all(...a: unknown[]): unknown[]
    run(...a: unknown[]): unknown
  }
}

export function migrateHet(db: SqlDb): number {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS het_schema (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT MAX(version) AS v FROM het_schema').get() as { v: number | null } | undefined
  let current = row?.v ?? 0
  for (const m of HET_MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO het_schema (version) VALUES (?)').run(m.version)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    current = m.version
  }
  return current
}
