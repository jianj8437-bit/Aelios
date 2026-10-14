-- Overlay for frozen Aelios v2.0.0
-- (9f55cd1d84ed56e0f1e85b484c36bfc43d23f553).
--
-- This migration belongs to the maintained October patch train. It is applied
-- only to the isolated Xu Heng D1 after upstream migrations 0001-0016. The
-- fixed namespace/source checks and the triggers below are the synchronous
-- validity boundary; Vectorize/FTS cleanup is allowed to converge later, but a
-- stale derivative can never pass these D1 checks while cleanup is pending.

CREATE TABLE october_source_ledger (
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  source TEXT NOT NULL CHECK(source = 'shiyue-authoritative-chat'),
  source_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL CHECK(conversation_id LIKE 'xh:%'),
  speaker TEXT NOT NULL CHECK(speaker IN (
    'participant:user', 'participant:gu-chen', 'agent:xu-heng'
  )),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  event_time TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
  state TEXT NOT NULL CHECK(state IN ('active', 'tombstoned')),
  content_sha256 TEXT,
  message_id TEXT NOT NULL,
  cleanup_state TEXT NOT NULL DEFAULT 'complete'
    CHECK(cleanup_state IN ('complete', 'pending')),
  ingested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace, source, source_id),
  UNIQUE(namespace, message_id),
  CHECK(
    (operation = 'upsert' AND state = 'active' AND content_sha256 IS NOT NULL)
    OR
    (operation = 'delete' AND state = 'tombstoned' AND content_sha256 IS NULL)
  )
);

CREATE INDEX idx_october_source_conversation_time
ON october_source_ledger(namespace, conversation_id, event_time);

CREATE INDEX idx_october_source_state_revision
ON october_source_ledger(namespace, state, revision);

CREATE TABLE october_source_events (
  event_id TEXT PRIMARY KEY,
  contract_revision TEXT NOT NULL CHECK(contract_revision = 'october-xh-source-v1'),
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  source TEXT NOT NULL CHECK(source = 'shiyue-authoritative-chat'),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision > 0),
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
  content_sha256 TEXT,
  result_state TEXT NOT NULL CHECK(result_state IN ('active', 'tombstoned')),
  applied_at TEXT NOT NULL,
  UNIQUE(namespace, source, source_id, source_revision)
);

CREATE INDEX idx_october_source_events_source
ON october_source_events(namespace, source, source_id, source_revision);

CREATE TABLE october_source_refs (
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN (
    'candidate', 'memory', 'daily', 'weekly', 'monthly',
    'precious', 'longtail', 'glossary', 'trigger', 'vector'
  )),
  artifact_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source = 'shiyue-authoritative-chat'),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision > 0),
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'invalidated', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace, artifact_kind, artifact_id, source, source_id),
  FOREIGN KEY(namespace, source, source_id)
    REFERENCES october_source_ledger(namespace, source, source_id)
);

CREATE INDEX idx_october_source_refs_lookup
ON october_source_refs(namespace, artifact_kind, artifact_id, state);

CREATE INDEX idx_october_source_refs_source
ON october_source_refs(namespace, source, source_id, source_revision, state);

CREATE TABLE october_review_decisions (
  decision_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve', 'discard')),
  result_state TEXT NOT NULL CHECK(result_state IN ('active', 'deleted')),
  result_artifact_id TEXT,
  request_sha256 TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE(namespace, candidate_id),
  FOREIGN KEY(candidate_id) REFERENCES memory_candidates(id),
  CHECK(
    (action = 'approve' AND result_artifact_id IS NOT NULL)
    OR
    (action = 'discard' AND result_state = 'deleted' AND result_artifact_id IS NULL)
  )
);

-- Bounded legacy migration ledger. It stores provenance and hashes only; the
-- private card body remains in memories/memory_candidates and never appears in
-- an operational report. A source origin can be imported once, while a batch
-- can be rolled back without deleting its audit record.
CREATE TABLE october_migration_batches (
  batch_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  contract_revision TEXT NOT NULL CHECK(contract_revision = 'october-xh-source-v1'),
  payload_sha256 TEXT NOT NULL,
  requested_items INTEGER NOT NULL CHECK(requested_items BETWEEN 1 AND 25),
  state TEXT NOT NULL CHECK(state IN ('applied', 'rolled_back')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE october_migration_items (
  batch_id TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK(namespace = 'xu-heng'),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('lmc5_current', 'lmc5_review')),
  origin_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('memory', 'candidate')),
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
  state TEXT NOT NULL CHECK(state IN ('active', 'rolled_back')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(batch_id, origin_kind, origin_id),
  UNIQUE(namespace, origin_kind, origin_id),
  UNIQUE(namespace, artifact_kind, artifact_id),
  FOREIGN KEY(batch_id) REFERENCES october_migration_batches(batch_id)
);

CREATE INDEX idx_october_migration_items_batch_state
ON october_migration_items(batch_id, state, artifact_kind);

-- Stable v2.0.0 has no source column on glossary. The patch keeps the native
-- table and adds only the evidence IDs required by the common source gate.
ALTER TABLE glossary ADD COLUMN source_message_ids TEXT;

-- ---------------------------------------------------------------------
-- Source ledger invariants. Application validation supplies readable errors;
-- these triggers are the concurrency boundary inside D1.
-- ---------------------------------------------------------------------

CREATE TRIGGER october_source_first_revision_guard
BEFORE INSERT ON october_source_ledger
BEGIN
  SELECT (CASE WHEN NEW.revision <> 1
    THEN RAISE(ABORT, 'october_source_first_revision_must_be_one') END);
END;

CREATE TRIGGER october_source_revision_guard
BEFORE UPDATE OF revision, operation, state, content_sha256, conversation_id,
  speaker, role, event_time, message_id ON october_source_ledger
BEGIN
  SELECT (CASE WHEN NEW.revision <> OLD.revision + 1
    THEN RAISE(ABORT, 'october_source_revision_must_be_contiguous') END);
  SELECT (CASE WHEN
    NEW.namespace <> OLD.namespace OR
    NEW.source <> OLD.source OR
    NEW.source_id <> OLD.source_id OR
    NEW.conversation_id <> OLD.conversation_id OR
    NEW.speaker <> OLD.speaker OR
    NEW.role <> OLD.role OR
    NEW.event_time <> OLD.event_time
    THEN RAISE(ABORT, 'october_source_identity_metadata_immutable') END);
END;

CREATE TRIGGER october_source_ref_current_guard
BEFORE INSERT ON october_source_refs
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM october_source_ledger l
    WHERE l.namespace = NEW.namespace
      AND l.source = NEW.source
      AND l.source_id = NEW.source_id
      AND l.state = 'active'
      AND l.revision = NEW.source_revision
  ) THEN RAISE(ABORT, 'october_source_ref_not_current') END);
END;

CREATE TRIGGER october_source_ref_update_current_guard
BEFORE UPDATE OF source_revision, state ON october_source_refs
WHEN NEW.state IN ('pending', 'active')
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM october_source_ledger l
    WHERE l.namespace = NEW.namespace
      AND l.source = NEW.source
      AND l.source_id = NEW.source_id
      AND l.state = 'active'
      AND l.revision = NEW.source_revision
  ) THEN RAISE(ABORT, 'october_source_ref_not_current') END);
END;

-- ---------------------------------------------------------------------
-- Candidate and memory provenance. Source message IDs are immutable once an
-- artifact exists: a later source edit must create a new candidate/version,
-- never silently rebase an old model output onto new evidence.
-- ---------------------------------------------------------------------

CREATE TRIGGER october_candidate_source_guard
BEFORE INSERT ON memory_candidates
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN NEW.status <> 'pending'
    THEN RAISE(ABORT, 'october_candidate_must_start_pending') END);
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_candidate_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace
        AND l.message_id = j.value
        AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_candidate_source_not_current') END);
END;

CREATE TRIGGER october_candidate_attach_sources
AFTER INSERT ON memory_candidates
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs (
    namespace, artifact_kind, artifact_id, source, source_id,
    source_revision, state, created_at, updated_at
  )
  SELECT DISTINCT NEW.namespace, 'candidate', NEW.id, l.source, l.source_id,
    l.revision, 'pending', NEW.created_at, NEW.updated_at
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_candidate_sources_immutable
BEFORE UPDATE OF source_message_ids ON memory_candidates
WHEN OLD.namespace = 'xu-heng' AND NEW.source_message_ids <> OLD.source_message_ids
BEGIN
  SELECT RAISE(ABORT, 'october_candidate_sources_immutable');
END;

CREATE TRIGGER october_candidate_pending_cas
BEFORE UPDATE OF status ON memory_candidates
WHEN OLD.namespace = 'xu-heng' AND NEW.status <> OLD.status AND OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'october_candidate_not_pending');
END;

CREATE TRIGGER october_candidate_close_refs
AFTER UPDATE OF status ON memory_candidates
WHEN OLD.namespace = 'xu-heng' AND NEW.status <> 'pending'
BEGIN
  UPDATE october_source_refs
  SET state = 'deleted', updated_at = NEW.updated_at
  WHERE namespace = NEW.namespace
    AND artifact_kind = 'candidate'
    AND artifact_id = NEW.id
    AND state = 'pending';
END;

CREATE TRIGGER october_candidate_delete_refs
AFTER DELETE ON memory_candidates
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'candidate' AND artifact_id = OLD.id;
END;

CREATE TRIGGER october_memory_source_guard
BEFORE INSERT ON memories
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_memory_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace
        AND l.message_id = j.value
        AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_memory_source_not_current') END);
END;

CREATE TRIGGER october_memory_attach_sources
AFTER INSERT ON memories
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  INSERT INTO october_source_refs (
    namespace, artifact_kind, artifact_id, source, source_id,
    source_revision, state, created_at, updated_at
  )
  SELECT DISTINCT NEW.namespace, 'memory', NEW.id, l.source, l.source_id,
    l.revision, 'active', NEW.created_at, NEW.updated_at
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_memory_sources_immutable
BEFORE UPDATE OF source_message_ids ON memories
WHEN OLD.namespace = 'xu-heng' AND NEW.source_message_ids <> OLD.source_message_ids
BEGIN
  SELECT RAISE(ABORT, 'october_memory_sources_immutable');
END;

CREATE TRIGGER october_memory_no_resurrection
BEFORE UPDATE OF status ON memories
WHEN OLD.namespace = 'xu-heng' AND OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'october_memory_resurrection_forbidden');
END;

CREATE TRIGGER october_memory_close_refs
AFTER UPDATE OF status ON memories
WHEN OLD.namespace = 'xu-heng' AND NEW.status <> 'active'
BEGIN
  UPDATE october_source_refs
  SET state = 'deleted', updated_at = NEW.updated_at
  WHERE namespace = NEW.namespace
    AND artifact_kind = 'memory'
    AND artifact_id = NEW.id
    AND state = 'active';
END;

CREATE TRIGGER october_memory_delete_refs
AFTER DELETE ON memories
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'memory' AND artifact_id = OLD.id;
END;

-- ---------------------------------------------------------------------
-- Derived layers. Daily/precious/longtail/glossary point at raw source
-- messages. Weekly copies current daily refs; monthly copies current weekly
-- refs before the native rollup batch deletes its input rows.
-- ---------------------------------------------------------------------

CREATE TRIGGER october_daily_source_guard
BEFORE INSERT ON daily_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_daily_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_daily_source_not_current') END);
END;

CREATE TRIGGER october_daily_update_source_guard
BEFORE UPDATE OF source_message_ids ON daily_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_daily_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_daily_source_not_current') END);
END;

CREATE TRIGGER october_daily_attach_sources
AFTER INSERT ON daily_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'daily', NEW.date, l.source, l.source_id,
    l.revision, 'active', NEW.updated_at, NEW.updated_at
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_daily_refresh_sources
AFTER UPDATE OF source_message_ids ON daily_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = NEW.namespace AND artifact_kind = 'daily' AND artifact_id = NEW.date;
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'daily', NEW.date, l.source, l.source_id,
    l.revision, 'active', NEW.updated_at, NEW.updated_at
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_daily_delete_refs
AFTER DELETE ON daily_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'daily' AND artifact_id = OLD.date;
END;

CREATE TRIGGER october_precious_source_guard
BEFORE INSERT ON precious
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.context_message_ids, '')) = 0
      OR json_type(NEW.context_message_ids) <> 'array'
      OR json_array_length(NEW.context_message_ids) = 0
    THEN RAISE(ABORT, 'october_precious_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.context_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_precious_source_not_current') END);
END;

CREATE TRIGGER october_precious_attach_sources
AFTER INSERT ON precious
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'precious', NEW.id, l.source, l.source_id,
    l.revision, 'active', NEW.created_at, NEW.created_at
  FROM json_each(NEW.context_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_precious_delete_refs
AFTER DELETE ON precious
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'precious' AND artifact_id = OLD.id;
END;

CREATE TRIGGER october_longtail_source_guard
BEFORE INSERT ON longtail
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_longtail_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_longtail_source_not_current') END);
END;

CREATE TRIGGER october_longtail_attach_sources
AFTER INSERT ON longtail
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'longtail', NEW.id, l.source, l.source_id,
    l.revision, 'active', NEW.ts, NEW.ts
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_longtail_delete_refs
AFTER DELETE ON longtail
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'longtail' AND artifact_id = OLD.id;
END;

CREATE TRIGGER october_glossary_source_guard
BEFORE INSERT ON glossary
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '')) = 0
      OR json_type(NEW.source_message_ids) <> 'array'
      OR json_array_length(NEW.source_message_ids) = 0
    THEN RAISE(ABORT, 'october_glossary_requires_sources') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_message_ids) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_glossary_source_not_current') END);
END;

CREATE TRIGGER october_glossary_attach_sources
AFTER INSERT ON glossary
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'glossary', NEW.id, l.source, l.source_id,
    l.revision, 'active', NEW.updated_at, NEW.updated_at
  FROM json_each(NEW.source_message_ids) j
  JOIN october_source_ledger l
    ON l.namespace = NEW.namespace AND l.message_id = j.value
  WHERE l.state = 'active';
END;

CREATE TRIGGER october_glossary_sources_immutable
BEFORE UPDATE OF source_message_ids ON glossary
WHEN OLD.namespace = 'xu-heng' AND NEW.source_message_ids <> OLD.source_message_ids
BEGIN
  SELECT RAISE(ABORT, 'october_glossary_sources_immutable');
END;

CREATE TRIGGER october_glossary_close_refs
AFTER UPDATE OF status ON glossary
WHEN OLD.namespace = 'xu-heng' AND NEW.status <> 'active'
BEGIN
  UPDATE october_source_refs
  SET state = 'deleted', updated_at = NEW.updated_at
  WHERE namespace = NEW.namespace AND artifact_kind = 'glossary' AND artifact_id = NEW.id;
END;

CREATE TRIGGER october_weekly_source_guard
BEFORE INSERT ON weekly_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM october_source_refs r
    JOIN october_source_ledger l
      ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
    WHERE r.namespace = NEW.namespace AND r.artifact_kind = 'daily'
      AND r.artifact_id >= NEW.start_date AND r.artifact_id <= NEW.end_date
      AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision
  ) THEN RAISE(ABORT, 'october_weekly_requires_current_daily_sources') END);
END;

CREATE TRIGGER october_weekly_attach_sources
AFTER INSERT ON weekly_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'weekly', NEW.week, r.source, r.source_id,
    r.source_revision, 'active', NEW.updated_at, NEW.updated_at
  FROM october_source_refs r
  JOIN october_source_ledger l
    ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
  WHERE r.namespace = NEW.namespace AND r.artifact_kind = 'daily'
    AND r.artifact_id >= NEW.start_date AND r.artifact_id <= NEW.end_date
    AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision;
END;

CREATE TRIGGER october_weekly_refresh_sources
AFTER UPDATE ON weekly_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = NEW.namespace AND artifact_kind = 'weekly' AND artifact_id = NEW.week;
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'weekly', NEW.week, r.source, r.source_id,
    r.source_revision, 'active', NEW.updated_at, NEW.updated_at
  FROM october_source_refs r
  JOIN october_source_ledger l
    ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
  WHERE r.namespace = NEW.namespace AND r.artifact_kind = 'daily'
    AND r.artifact_id >= NEW.start_date AND r.artifact_id <= NEW.end_date
    AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision;
END;

CREATE TRIGGER october_weekly_delete_refs
AFTER DELETE ON weekly_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'weekly' AND artifact_id = OLD.week;
END;

CREATE TRIGGER october_monthly_source_guard
BEFORE INSERT ON monthly_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM weekly_log w
    JOIN october_source_refs r
      ON r.namespace = w.namespace AND r.artifact_kind = 'weekly' AND r.artifact_id = w.week
    JOIN october_source_ledger l
      ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
    WHERE w.namespace = NEW.namespace AND substr(w.start_date, 1, 7) = NEW.month
      AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision
  ) THEN RAISE(ABORT, 'october_monthly_requires_current_weekly_sources') END);
END;

CREATE TRIGGER october_monthly_attach_sources
AFTER INSERT ON monthly_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'monthly', NEW.month, r.source, r.source_id,
    r.source_revision, 'active', NEW.updated_at, NEW.updated_at
  FROM weekly_log w
  JOIN october_source_refs r
    ON r.namespace = w.namespace AND r.artifact_kind = 'weekly' AND r.artifact_id = w.week
  JOIN october_source_ledger l
    ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
  WHERE w.namespace = NEW.namespace AND substr(w.start_date, 1, 7) = NEW.month
    AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision;
END;

CREATE TRIGGER october_monthly_refresh_sources
AFTER UPDATE ON monthly_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = NEW.namespace AND artifact_kind = 'monthly' AND artifact_id = NEW.month;
  INSERT INTO october_source_refs
  SELECT DISTINCT NEW.namespace, 'monthly', NEW.month, r.source, r.source_id,
    r.source_revision, 'active', NEW.updated_at, NEW.updated_at
  FROM weekly_log w
  JOIN october_source_refs r
    ON r.namespace = w.namespace AND r.artifact_kind = 'weekly' AND r.artifact_id = w.week
  JOIN october_source_ledger l
    ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
  WHERE w.namespace = NEW.namespace AND substr(w.start_date, 1, 7) = NEW.month
    AND r.state = 'active' AND l.state = 'active' AND l.revision = r.source_revision;
END;

CREATE TRIGGER october_monthly_delete_refs
AFTER DELETE ON monthly_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  DELETE FROM october_source_refs
  WHERE namespace = OLD.namespace AND artifact_kind = 'monthly' AND artifact_id = OLD.month;
END;

-- A review decision is accepted only while the candidate is still pending and
-- every one of its source refs is current. A target-bearing approval must not
-- fall back to creating a new fact after its target disappears.
CREATE TRIGGER october_review_decision_guard
BEFORE INSERT ON october_review_decisions
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM memory_candidates c
    WHERE c.namespace = NEW.namespace AND c.id = NEW.candidate_id AND c.status = 'pending'
  ) THEN RAISE(ABORT, 'october_candidate_not_pending') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM october_source_refs r
    JOIN october_source_ledger l
      ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
    WHERE r.namespace = NEW.namespace AND r.artifact_kind = 'candidate'
      AND r.artifact_id = NEW.candidate_id AND r.state = 'pending'
      AND l.state = 'active' AND l.revision = r.source_revision
  ) THEN RAISE(ABORT, 'october_candidate_sources_not_current') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM october_source_refs r
    LEFT JOIN october_source_ledger l
      ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
    WHERE r.namespace = NEW.namespace AND r.artifact_kind = 'candidate'
      AND r.artifact_id = NEW.candidate_id
      AND (r.state <> 'pending' OR l.state <> 'active' OR l.revision <> r.source_revision)
  ) THEN RAISE(ABORT, 'october_candidate_sources_not_current') END);
  SELECT (CASE WHEN NEW.action = 'approve' AND NEW.result_state = 'active' AND NOT EXISTS (
    SELECT 1 FROM memories m
    WHERE m.namespace = NEW.namespace AND m.id = NEW.result_artifact_id AND m.status = 'active'
  ) THEN RAISE(ABORT, 'october_review_result_memory_missing') END);
  SELECT (CASE WHEN NEW.action = 'approve' AND EXISTS (
    SELECT 1 FROM memory_candidates c
    WHERE c.namespace = NEW.namespace AND c.id = NEW.candidate_id
      AND c.target_memory_id IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM memory_candidates c
    JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_memory_id
    WHERE c.namespace = NEW.namespace AND c.id = NEW.candidate_id AND m.status = 'active'
  ) THEN RAISE(ABORT, 'october_review_target_not_active') END);
END;
