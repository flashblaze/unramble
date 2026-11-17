-- Words Whisper and the extraction model should spell your way (PLAN.md, Phase 2c).
-- Managed with `bun run vocab`; read by /extract.
CREATE TABLE vocabulary (
  word     TEXT PRIMARY KEY COLLATE NOCASE,
  added_at INTEGER NOT NULL
);

INSERT INTO vocabulary (word, added_at) VALUES ('Unramble', 0), ('TickTick', 0);
