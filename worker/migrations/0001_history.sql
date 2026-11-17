-- Dictation history (PLAN.md, Phase 2b). Written only by the queue consumer; rows are immutable.

CREATE TABLE dictations (
  id             TEXT PRIMARY KEY,      -- UUID, returned to the watch as dictationId
  created_at     INTEGER NOT NULL,      -- unix ms
  tz             TEXT NOT NULL,
  outcome        TEXT NOT NULL,         -- 'extracted' | 'no_speech' | 'failed'
  error          TEXT,                  -- error type when failed (never message text)
  transcript     TEXT,                  -- null if Whisper failed
  extracted_json TEXT,                  -- tasks the model proposed
  model          TEXT,
  audio_key      TEXT,                  -- R2 key in unramble-audio; null if the put failed
  audio_bytes    INTEGER NOT NULL,
  audio_error    TEXT,
  whisper_ms     INTEGER,
  llm_ms         INTEGER
);
CREATE INDEX dictations_created_at ON dictations (created_at DESC);

CREATE TABLE submissions (
  id             TEXT PRIMARY KEY,      -- per /tasks call: idempotency for at-least-once delivery
  dictation_id   TEXT NOT NULL,         -- may arrive before its dictation row; joined at read time
  created_at     INTEGER NOT NULL,
  submitted_json TEXT NOT NULL,         -- tasks you kept and sent
  created_count  INTEGER NOT NULL,
  failed_count   INTEGER NOT NULL
);
CREATE INDEX submissions_dictation ON submissions (dictation_id);

-- Full-text search over transcripts (external content: the text lives once, in dictations).
CREATE VIRTUAL TABLE dictations_fts USING fts5 (transcript, content = 'dictations', content_rowid = 'rowid');

CREATE TRIGGER dictations_fts_insert AFTER INSERT ON dictations BEGIN
  INSERT INTO dictations_fts (rowid, transcript) VALUES (new.rowid, new.transcript);
END;

CREATE TRIGGER dictations_fts_delete AFTER DELETE ON dictations BEGIN
  INSERT INTO dictations_fts (dictations_fts, rowid, transcript) VALUES ('delete', old.rowid, old.transcript);
END;
