// Versioned, append-only schema migrations. Never edit an applied migration;
// add a new version instead. Every per-user table MUST reference
// accounts(id) ON DELETE CASCADE so DELETE /v1/account erases everything.
//
// Times are integer milliseconds since the Unix epoch (UTC).

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'auth_core',
    sql: `
      CREATE TABLE accounts (
        id          TEXT    PRIMARY KEY,           -- = fingerprint: lowercase hex sha256(raw Ed25519 public key)
        public_key  TEXT    NOT NULL UNIQUE,       -- base64url raw 32-byte Ed25519 public key
        created_at  INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE auth_challenges (
        id          TEXT    PRIMARY KEY,           -- uuid v4
        public_key  TEXT    NOT NULL,              -- base64url raw key the challenge was issued to
        nonce       TEXT    NOT NULL,              -- base64url 32 random bytes
        audience    TEXT    NOT NULL,              -- CLOUD_PUBLIC_ORIGIN at issue time
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER                        -- set on ANY verify attempt (single use)
      ) STRICT;
      CREATE INDEX auth_challenges_expires ON auth_challenges(expires_at);

      CREATE TABLE sessions (
        token_hash  TEXT    PRIMARY KEY,           -- lowercase hex sha256(token); the token itself is never stored
        account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX sessions_account ON sessions(account_id);
      CREATE INDEX sessions_expires ON sessions(expires_at);
    `
  },
  {
    version: 2,
    name: 'chat_usage',
    // Counters only: no message or context content is ever stored.
    sql: `
      CREATE TABLE chat_usage (
        id                INTEGER PRIMARY KEY,
        account_id        TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        day               TEXT    NOT NULL,        -- UTC YYYY-MM-DD
        ts                INTEGER NOT NULL,        -- request start, ms
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        model             TEXT    NOT NULL,
        status            TEXT    NOT NULL,        -- stop | length | error | aborted | upstream_error | upstream_timeout
        latency_ms        INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX chat_usage_account_day ON chat_usage(account_id, day);
    `
  },
  {
    version: 3,
    name: 'cards_letters_subscribers',
    // C8 + C9. Raw email addresses live ONLY in subscribers.email; every other table keys on
    // email_hash = HMAC-SHA256(pepper, lowercased address) or on a random subscriber id.
    sql: `
      CREATE TABLE server_secrets (
        name        TEXT    PRIMARY KEY,           -- e.g. email_pepper (only when CLOUD_EMAIL_PEPPER is unset)
        value       TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE cards (
        account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        version      INTEGER NOT NULL,
        card_text    TEXT    NOT NULL,             -- verbatim .navaliacard text (never edited)
        text_sha256  TEXT    NOT NULL,
        display_name TEXT,                         -- copy of content.front.display_name (From name, /s page)
        published_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, version)
      ) STRICT;

      CREATE TABLE card_counters (
        account_id   TEXT    PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        last_version INTEGER NOT NULL              -- monotonic across DELETE /v1/cards
      ) STRICT;

      CREATE TABLE letters (
        id           TEXT    PRIMARY KEY,          -- letter_id (uuid v4, server-assigned)
        account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        issue_id     TEXT    NOT NULL,
        week         TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,             -- envelope created_at (ISO, signed)
        envelope     TEXT,                         -- verbatim signed envelope; NULL once purged
        published_at INTEGER NOT NULL,
        purged_at    INTEGER,
        UNIQUE (account_id, issue_id)
      ) STRICT;
      CREATE INDEX letters_account_published ON letters(account_id, published_at);

      CREATE TABLE subscribers (
        id                 TEXT    PRIMARY KEY,    -- uuid v4
        account_id         TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email              TEXT    NOT NULL,       -- raw address (trimmed); deleted on unsubscribe/removal
        email_hash         TEXT    NOT NULL,
        status             TEXT    NOT NULL CHECK (status IN ('pending', 'confirmed')),
        created_at         INTEGER NOT NULL,
        confirmed_at       INTEGER,
        confirm_token_hash TEXT    UNIQUE,         -- sha256(token); NULL once confirmed
        confirm_expires_at INTEGER,
        UNIQUE (account_id, email_hash)
      ) STRICT;

      CREATE TABLE suppressions (
        account_id            TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email_hash            TEXT    NOT NULL,
        former_subscriber_id  TEXT    NOT NULL,    -- lets an old unsubscribe link start a re-subscribe
        created_at            INTEGER NOT NULL,
        PRIMARY KEY (account_id, email_hash)
      ) STRICT;
      CREATE INDEX suppressions_former ON suppressions(former_subscriber_id);

      -- Per-address confirmation-mail cap (across publishers). Hash only; rows older than 24 h are purged.
      CREATE TABLE confirm_sends (
        email_hash  TEXT    NOT NULL,
        sent_at     INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX confirm_sends_hash ON confirm_sends(email_hash, sent_at);

      -- Confirmation mails waiting to be sent. The raw token lives here only until the mail is
      -- handed to the transport (or fails terminally); then the row is deleted.
      CREATE TABLE confirm_queue (
        id              INTEGER PRIMARY KEY,
        subscriber_id   TEXT    NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        token           TEXT    NOT NULL,
        status          TEXT    NOT NULL CHECK (status IN ('queued', 'sending')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE deliveries (
        id              INTEGER PRIMARY KEY,
        letter_id       TEXT    NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
        account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        subscriber_id   TEXT    NOT NULL,          -- no FK: the row outlives the subscriber (no PII here)
        email_masked    TEXT    NOT NULL,          -- a***@example.com
        status          TEXT    NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        error_code      TEXT,
        UNIQUE (letter_id, subscriber_id)
      ) STRICT;
      CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
      CREATE INDEX deliveries_subscriber ON deliveries(subscriber_id);
    `
  },
  {
    version: 4,
    name: 'meetings',
    // C13. Audio bytes never live in the DB: meeting_chunks.audio_name points at a random-named file
    // in CLOUD_AUDIO_DIR and is set to NULL as soon as that file is deleted (transcribed, failed,
    // swept after 24 h). Per-chunk results are dropped once the meeting transcript is assembled.
    sql: `
      CREATE TABLE meetings (
        id                TEXT    PRIMARY KEY,     -- uuid v4
        account_id        TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title             TEXT    NOT NULL,
        status            TEXT    NOT NULL CHECK (status IN ('recording', 'transcribing', 'ready', 'failed')),
        consent_version   INTEGER NOT NULL,
        language_hints    TEXT    NOT NULL,        -- JSON array of ISO 639-1 codes
        created_at        INTEGER NOT NULL,
        finished_at       INTEGER,                 -- finish accepted
        ended_at          INTEGER,                 -- ready / failed
        chunk_count       INTEGER,                 -- n from finish
        duration_ms       INTEGER NOT NULL DEFAULT 0,
        error_code        TEXT,
        transcript        TEXT                     -- JSON {language, segments, text}; NULL until ready
      ) STRICT;
      CREATE INDEX meetings_account_created ON meetings(account_id, created_at);

      CREATE TABLE meeting_chunks (
        id              INTEGER PRIMARY KEY,
        meeting_id      TEXT    NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        sha256          TEXT    NOT NULL,
        content_type    TEXT    NOT NULL,          -- audio/webm | audio/ogg | audio/wav (params dropped)
        duration_ms     INTEGER NOT NULL,
        bytes           INTEGER NOT NULL,
        audio_name      TEXT    UNIQUE,            -- random file name in CLOUD_AUDIO_DIR; NULL once deleted
        status          TEXT    NOT NULL CHECK (status IN ('queued', 'transcribing', 'done', 'failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        error_code      TEXT,
        result          TEXT,                      -- JSON {language, segments (chunk-relative)}; NULL after assembly
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE (meeting_id, seq)
      ) STRICT;
      CREATE INDEX meeting_chunks_due ON meeting_chunks(status, next_attempt_at);
      CREATE INDEX meeting_chunks_account ON meeting_chunks(account_id);

      -- Daily audio budget. Survives DELETE /v1/meetings/:id on purpose (deleting must not refund quota).
      CREATE TABLE stt_usage (
        account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        day         TEXT    NOT NULL,              -- UTC YYYY-MM-DD
        ms          INTEGER NOT NULL,
        PRIMARY KEY (account_id, day)
      ) STRICT;
    `
  },
  {
    version: 5,
    name: 'moments',
    sql: `
      -- C18 shared moments. The server is a relay: signed texts are stored verbatim; clients re-verify.
      -- other_id is deliberately NOT a foreign key (the other person may not have an account yet);
      -- the trigger below deletes their moments when their account is deleted (consent withdrawn).
      CREATE TABLE moments (
        id              TEXT    PRIMARY KEY,           -- moment_id (lowercase uuid, chosen by the proposer)
        proposer_id     TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        other_id        TEXT    NOT NULL,              -- fingerprint of the participant who must accept
        status          TEXT    NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')),
        moment_text     TEXT    NOT NULL,              -- signed moment, verbatim
        moment_sha256   TEXT    NOT NULL,              -- hex sha256 of canonical signed moment
        acceptance_text TEXT,                          -- signed acceptance, verbatim; NULL unless accepted
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX moments_proposer ON moments(proposer_id, status);
      CREATE INDEX moments_other ON moments(other_id);
      CREATE TRIGGER moments_account_deleted AFTER DELETE ON accounts BEGIN
        DELETE FROM moments WHERE other_id = OLD.id;
      END;

      -- Daily proposal counter (deleting a moment does not refund it).
      CREATE TABLE moment_usage (
        account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        day         TEXT    NOT NULL,                  -- UTC YYYY-MM-DD
        n           INTEGER NOT NULL,
        PRIMARY KEY (account_id, day)
      ) STRICT;
    `
  }
]
