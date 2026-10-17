-- Xu Heng's memory follows upstream Aelios as it is (her 2026-10-16 calls: 「每条记忆都要找得到原文是旧记忆
-- 系统的要求」, 「我们直接套用这个开源记忆库先用一段时间，然后再看问题，修改」).
--
-- 0017 refused any memory, candidate or derived layer that did not cite a synced chat message, froze what was
-- cited and forbade restoring a deleted memory. The /admin panel adds, edits and restores memories without that,
-- so those checks go. What stays is what the sync needs so that a deleted or edited chat message does not come
-- back: whatever does cite messages must cite current ones, and the reference bookkeeping that takes derived
-- artifacts down with their message.

DROP TRIGGER IF EXISTS october_memory_sources_immutable;
DROP TRIGGER IF EXISTS october_memory_no_resurrection;
DROP TRIGGER IF EXISTS october_candidate_sources_immutable;
DROP TRIGGER IF EXISTS october_glossary_sources_immutable;
DROP TRIGGER IF EXISTS october_weekly_source_guard;
DROP TRIGGER IF EXISTS october_monthly_source_guard;

DROP TRIGGER IF EXISTS october_memory_source_guard;
CREATE TRIGGER october_memory_source_guard
BEFORE INSERT ON memories
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_memory_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_candidate_source_guard;
CREATE TRIGGER october_candidate_source_guard
BEFORE INSERT ON memory_candidates
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN NEW.status <> 'pending'
    THEN RAISE(ABORT, 'october_candidate_must_start_pending') END);
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_candidate_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_daily_source_guard;
CREATE TRIGGER october_daily_source_guard
BEFORE INSERT ON daily_log
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_daily_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_daily_update_source_guard;
CREATE TRIGGER october_daily_update_source_guard
BEFORE UPDATE OF source_message_ids ON daily_log
WHEN OLD.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_daily_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_precious_source_guard;
CREATE TRIGGER october_precious_source_guard
BEFORE INSERT ON precious
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.context_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.context_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.context_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_precious_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_longtail_source_guard;
CREATE TRIGGER october_longtail_source_guard
BEFORE INSERT ON longtail
WHEN NEW.namespace = 'xu-heng'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_longtail_source_not_current') END);
END;

DROP TRIGGER IF EXISTS october_glossary_source_guard;
CREATE TRIGGER october_glossary_source_guard
BEFORE INSERT ON glossary
WHEN NEW.namespace = 'xu-heng' AND NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN json_valid(COALESCE(NEW.source_message_ids, '[]')) = 1 AND json_type(COALESCE(NEW.source_message_ids, '[]')) = 'array' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(NEW.source_message_ids, '[]')) j
    WHERE typeof(j.value) <> 'text' OR NOT EXISTS (
      SELECT 1 FROM october_source_ledger l
      WHERE l.namespace = NEW.namespace AND l.message_id = j.value AND l.state = 'active'
    )
  ) THEN RAISE(ABORT, 'october_glossary_source_not_current') END);
END;
