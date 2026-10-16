import { clampMemoryType } from "../memory/canonicalTypes";
import { getMemoryById } from "../db/memories";
import { upsertMemoryEmbedding } from "../memory/embedding";
import { deleteFtsRow, upsertMemoryFts, upsertMessageFts } from "../memory/fts";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { nowIso } from "../utils/time";
import {
  OCTOBER_CONTRACT_REVISION,
  OCTOBER_NAMESPACE,
  OCTOBER_SOURCE,
  OctoberContractError,
  type OctoberSourceEvent,
  octoberReviewMemoryId
} from "./contract";

// The ledger keeps the source's own event_time exactly. The upstream message table is compared with UTC day
// ranges (Dream, diary, retention), so it stores the same instant in UTC: "2026-10-15T00:30:00+08:00" becomes
// "2026-10-14T16:30:00.000Z" and lands on 10-15 in Asia/Singapore, not on 10-14.
function utcInstant(eventTime: string): string {
  return new Date(eventTime).toISOString();
}

export type OctoberArtifactKind =
  | "candidate"
  | "memory"
  | "daily"
  | "weekly"
  | "monthly"
  | "precious"
  | "longtail"
  | "glossary"
  | "trigger"
  | "vector";

export interface OctoberSourceLedgerRow {
  namespace: string;
  source: string;
  source_id: string;
  conversation_id: string;
  speaker: string;
  role: "user" | "assistant";
  event_time: string;
  revision: number;
  operation: "upsert" | "delete";
  state: "active" | "tombstoned";
  content_sha256: string | null;
  message_id: string;
  cleanup_state: "complete" | "pending";
  ingested_at: string;
  updated_at: string;
}

interface OctoberSourceEventRow {
  event_id: string;
  source_id: string;
  source_revision: number;
  operation: "upsert" | "delete";
  content_sha256: string | null;
  result_state: "active" | "tombstoned";
}

export interface OctoberSourceAck {
  contract_revision: typeof OCTOBER_CONTRACT_REVISION;
  namespace: typeof OCTOBER_NAMESPACE;
  source: typeof OCTOBER_SOURCE;
  source_id: string;
  revision: number;
  current_revision: number;
  operation: "upsert" | "delete";
  event_id: string;
  state: "active" | "tombstoned";
  cleanup_state: "complete" | "pending";
  applied: boolean;
  duplicate: boolean;
}

export interface OctoberProvenance {
  namespace: typeof OCTOBER_NAMESPACE;
  source: typeof OCTOBER_SOURCE;
  source_id: string;
  revision: number;
  current_revision: number;
  state: "active";
  message_id: string;
  conversation_id: string;
  speaker: string;
  event_time: string;
}

type RefQueryRow = {
  artifact_id: string;
  ref_state: string;
  source: string;
  source_id: string;
  source_revision: number;
  ledger_state: string | null;
  current_revision: number | null;
  message_id: string | null;
  conversation_id: string | null;
  speaker: string | null;
  event_time: string | null;
};

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function ackFor(
  event: OctoberSourceEvent,
  cleanupState: "complete" | "pending",
  applied: boolean,
  duplicate: boolean
): OctoberSourceAck {
  return {
    contract_revision: OCTOBER_CONTRACT_REVISION,
    namespace: OCTOBER_NAMESPACE,
    source: OCTOBER_SOURCE,
    source_id: event.source_id,
    revision: event.revision,
    current_revision: event.revision,
    operation: event.operation,
    event_id: event.event_id,
    state: event.operation === "upsert" ? "active" : "tombstoned",
    cleanup_state: cleanupState,
    applied,
    duplicate
  };
}

function dbError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    "october_source_first_revision_must_be_one",
    "october_source_revision_must_be_contiguous",
    "october_source_identity_metadata_immutable",
    "october_source_ref_not_current",
    "october_candidate_not_pending",
    "october_candidate_sources_not_current",
    "october_review_target_not_active",
    "october_review_result_memory_missing"
  ].find((code) => message.includes(code));
  if (known) throw new OctoberContractError(known, known.replaceAll("_", " "), 409);
  if (/UNIQUE constraint failed: october_review_decisions/i.test(message)) {
    throw new OctoberContractError("decision_conflict", "candidate already has a different decision", 409);
  }
  throw error;
}

async function sourceRow(db: D1Database, sourceId: string): Promise<OctoberSourceLedgerRow | null> {
  return (
    (await db
      .prepare(
        `SELECT * FROM october_source_ledger
         WHERE namespace = ? AND source = ? AND source_id = ?`
      )
      .bind(OCTOBER_NAMESPACE, OCTOBER_SOURCE, sourceId)
      .first<OctoberSourceLedgerRow>()) ?? null
  );
}

async function sourceMessageIsCurrent(
  db: D1Database,
  event: OctoberSourceEvent
): Promise<boolean> {
  const row = await sourceRow(db, event.source_id);
  return row?.state === "active" &&
    row.revision === event.revision &&
    row.message_id === event.message_id;
}

async function eventRow(db: D1Database, eventId: string): Promise<OctoberSourceEventRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM october_source_events WHERE event_id = ?")
      .bind(eventId)
      .first<OctoberSourceEventRow>()) ?? null
  );
}

function validateRevision(event: OctoberSourceEvent, current: OctoberSourceLedgerRow | null): void {
  if (!current) {
    if (event.revision !== 1) {
      throw new OctoberContractError("revision_gap", "the first source revision must be 1", 409);
    }
    return;
  }
  if (event.revision < current.revision) {
    throw new OctoberContractError("stale_revision", "source revision is older than current", 409);
  }
  if (event.revision === current.revision) {
    const same =
      current.operation === event.operation &&
      current.conversation_id === event.conversation_id &&
      current.speaker === event.speaker &&
      current.role === event.role &&
      current.event_time === event.event_time &&
      sameNullable(current.content_sha256, event.content_sha256);
    if (!same) {
      throw new OctoberContractError(
        "revision_conflict",
        "the source revision already has different content or metadata",
        409
      );
    }
    return;
  }
  if (event.revision !== current.revision + 1) {
    throw new OctoberContractError("revision_gap", "source revisions must be contiguous", 409);
  }
  if (
    event.conversation_id !== current.conversation_id ||
    event.speaker !== current.speaker ||
    event.role !== current.role ||
    event.event_time !== current.event_time
  ) {
    throw new OctoberContractError(
      "metadata_conflict",
      "source identity metadata is immutable across revisions",
      409
    );
  }
}

type CleanupArtifactRow = {
  artifact_kind: string;
  artifact_id: string;
  vector_id: string | null;
};

async function cleanupArtifactsForSource(
  db: D1Database,
  sourceId: string,
  beforeRevision: number
): Promise<CleanupArtifactRow[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT r.artifact_kind, r.artifact_id, m.vector_id
       FROM october_source_refs r
       LEFT JOIN memories m
         ON r.artifact_kind = 'memory' AND m.namespace = r.namespace AND m.id = r.artifact_id
       WHERE r.namespace = ? AND r.source = ? AND r.source_id = ?
         AND r.source_revision < ?`
    )
    .bind(OCTOBER_NAMESPACE, OCTOBER_SOURCE, sourceId, beforeRevision)
    .all<CleanupArtifactRow>();
  return result.results ?? [];
}

function vectorIdsForCleanup(rows: CleanupArtifactRow[]): string[] {
  const values = rows.flatMap((row) => {
    if (row.artifact_kind === "memory") return row.vector_id ? [row.vector_id] : [];
    if (row.artifact_kind === "longtail") return [`lt_${row.artifact_id}`, row.artifact_id];
    if (row.artifact_kind === "vector") return [row.artifact_id];
    return [];
  });
  return [...new Set(values.filter(Boolean))];
}

async function finishVectorCleanup(
  env: Env,
  event: OctoberSourceEvent,
  vectorIds: string[]
): Promise<"complete" | "pending"> {
  if (vectorIds.length > 0) {
    if (!env.VECTORIZE) return "pending";
    try {
      await env.VECTORIZE.deleteByIds(vectorIds);
    } catch (error) {
      console.error("october source vector cleanup pending", {
        source_id: event.source_id,
        revision: event.revision,
        count: vectorIds.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return "pending";
    }
  }
  await env.DB
    .prepare(
      `UPDATE october_source_ledger
       SET cleanup_state = 'complete', updated_at = ?
       WHERE namespace = ? AND source = ? AND source_id = ? AND revision = ?`
    )
    .bind(nowIso(), OCTOBER_NAMESPACE, OCTOBER_SOURCE, event.source_id, event.revision)
    .run();
  return "complete";
}

async function markArtifactCleanupPending(
  db: D1Database,
  kind: OctoberArtifactKind,
  artifactId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE october_source_ledger AS ledger
       SET cleanup_state = 'pending', updated_at = ?
       WHERE ledger.namespace = ? AND ledger.source = ?
         AND EXISTS (
           SELECT 1 FROM october_source_refs AS ref
           WHERE ref.namespace = ledger.namespace
             AND ref.source = ledger.source
             AND ref.source_id = ledger.source_id
             AND ref.artifact_kind = ? AND ref.artifact_id = ?
         )`
    )
    .bind(nowIso(), OCTOBER_NAMESPACE, OCTOBER_SOURCE, kind, artifactId)
    .run();
}

export async function applyOctoberSourceEvent(
  env: Env,
  event: OctoberSourceEvent
): Promise<OctoberSourceAck> {
  const [current, receipt] = await Promise.all([
    sourceRow(env.DB, event.source_id),
    eventRow(env.DB, event.event_id)
  ]);

  if (receipt && current?.revision === event.revision) {
    return ackFor(event, current.cleanup_state, false, true);
  }
  validateRevision(event, current);
  if (current?.revision === event.revision) {
    return ackFor(event, current.cleanup_state, false, true);
  }

  const cleanupRows = current
    ? await cleanupArtifactsForSource(env.DB, event.source_id, event.revision)
    : [];
  const vectorIds = vectorIdsForCleanup(cleanupRows);
  const stamp = nowIso();
  const nextState = event.operation === "upsert" ? "active" : "tombstoned";
  const cleanupState = current ? "pending" : "complete";
  const statements: D1PreparedStatement[] = [];

  if (current) {
    statements.push(
      env.DB
        .prepare(
          `UPDATE memories
           SET status = 'deleted', updated_at = ?
           WHERE namespace = ? AND id IN (
             SELECT artifact_id FROM october_source_refs
             WHERE namespace = ? AND source = ? AND source_id = ?
               AND artifact_kind = 'memory' AND state = 'active'
           )`
        )
        .bind(stamp, OCTOBER_NAMESPACE, OCTOBER_NAMESPACE, OCTOBER_SOURCE, event.source_id),
      env.DB
        .prepare(
          `UPDATE memory_candidates
           SET status = 'discarded', decision_note = 'source_revision_invalidated', updated_at = ?
           WHERE namespace = ? AND status = 'pending' AND id IN (
             SELECT artifact_id FROM october_source_refs
             WHERE namespace = ? AND source = ? AND source_id = ?
               AND artifact_kind = 'candidate' AND state = 'pending'
           )`
        )
        .bind(stamp, OCTOBER_NAMESPACE, OCTOBER_NAMESPACE, OCTOBER_SOURCE, event.source_id),
      env.DB
        .prepare(
          `DELETE FROM memory_fts WHERE memory_id IN (
             SELECT artifact_id FROM october_source_refs
             WHERE namespace = ? AND source = ? AND source_id = ?
               AND artifact_kind = 'memory'
           )`
        )
        .bind(OCTOBER_NAMESPACE, OCTOBER_SOURCE, event.source_id),
      env.DB.prepare("DELETE FROM message_fts WHERE message_id = ?").bind(current.message_id),
      env.DB
        .prepare("DELETE FROM messages WHERE namespace = ? AND id = ?")
        .bind(OCTOBER_NAMESPACE, current.message_id),
      env.DB
        .prepare(
          `UPDATE october_source_refs
           SET state = 'invalidated', updated_at = ?
           WHERE namespace = ? AND source = ? AND source_id = ?
             AND state IN ('pending', 'active')`
        )
        .bind(stamp, OCTOBER_NAMESPACE, OCTOBER_SOURCE, event.source_id)
    );
  }

  statements.push(
    env.DB
      .prepare(
        `INSERT INTO conversations (id, namespace, title, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .bind(event.conversation_id, OCTOBER_NAMESPACE, utcInstant(event.event_time), stamp)
  );

  if (event.operation === "upsert") {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO messages (
             id, conversation_id, namespace, role, content, source, created_at, seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             conversation_id = excluded.conversation_id,
             role = excluded.role,
             content = excluded.content,
             source = excluded.source,
             created_at = excluded.created_at,
             seq = excluded.seq`
        )
        .bind(
          event.message_id,
          event.conversation_id,
          OCTOBER_NAMESPACE,
          event.role,
          event.content,
          OCTOBER_SOURCE,
          utcInstant(event.event_time),
          event.role === "user" ? 0 : 1
        )
    );
  } else {
    statements.push(
      env.DB
        .prepare("DELETE FROM messages WHERE namespace = ? AND id = ?")
        .bind(OCTOBER_NAMESPACE, event.message_id)
    );
  }

  if (current) {
    statements.push(
      env.DB
        .prepare(
          `UPDATE october_source_ledger SET
             revision = ?, operation = ?, state = ?, content_sha256 = ?,
             message_id = ?, cleanup_state = ?, updated_at = ?
           WHERE namespace = ? AND source = ? AND source_id = ?`
        )
        .bind(
          event.revision,
          event.operation,
          nextState,
          event.content_sha256,
          event.message_id,
          cleanupState,
          stamp,
          OCTOBER_NAMESPACE,
          OCTOBER_SOURCE,
          event.source_id
        )
    );
  } else {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO october_source_ledger (
             namespace, source, source_id, conversation_id, speaker, role,
             event_time, revision, operation, state, content_sha256, message_id,
             cleanup_state, ingested_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          OCTOBER_NAMESPACE,
          OCTOBER_SOURCE,
          event.source_id,
          event.conversation_id,
          event.speaker,
          event.role,
          event.event_time,
          event.revision,
          event.operation,
          nextState,
          event.content_sha256,
          event.message_id,
          cleanupState,
          stamp,
          stamp
        )
    );
  }

  statements.push(
    env.DB
      .prepare(
        `INSERT INTO october_source_events (
           event_id, contract_revision, namespace, source, source_id,
           source_revision, operation, content_sha256, result_state, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.event_id,
        OCTOBER_CONTRACT_REVISION,
        OCTOBER_NAMESPACE,
        OCTOBER_SOURCE,
        event.source_id,
        event.revision,
        event.operation,
        event.content_sha256,
        nextState,
        stamp
      )
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const [racedCurrent, racedReceipt] = await Promise.all([
      sourceRow(env.DB, event.source_id),
      eventRow(env.DB, event.event_id)
    ]);
    if (
      racedReceipt &&
      racedCurrent?.revision === event.revision &&
      racedCurrent.operation === event.operation &&
      racedCurrent.conversation_id === event.conversation_id &&
      racedCurrent.speaker === event.speaker &&
      racedCurrent.role === event.role &&
      racedCurrent.event_time === event.event_time &&
      sameNullable(racedCurrent.content_sha256, event.content_sha256)
    ) {
      return ackFor(event, racedCurrent.cleanup_state, false, true);
    }
    dbError(error);
  }

  if (event.operation === "upsert" && event.content !== null) {
    if (await sourceMessageIsCurrent(env.DB, event)) {
      // Each revision has its own message_id (octoberMessageId) and the batch above already removed
      // the previous revision's row, so there is nothing to replace: without the delete, one message
      // reads a few rows instead of the whole message_fts table (her free D1 plan, 2026-10-16).
      const indexed = await upsertMessageFts(env.DB, {
        namespace: OCTOBER_NAMESPACE,
        messageId: event.message_id,
        content: event.content,
        fresh: true
      });
      if (indexed && !(await sourceMessageIsCurrent(env.DB, event))) {
        await deleteFtsRow(env.DB, "message_fts", "message_id", event.message_id);
      }
    }
  }

  const completed = await finishVectorCleanup(env, event, vectorIds);
  return ackFor(event, completed, true, false);
}

export async function currentArtifactProvenance(
  db: D1Database,
  kind: OctoberArtifactKind,
  artifactIds: string[]
): Promise<Map<string, OctoberProvenance[]>> {
  const ids = [...new Set(artifactIds.map((id) => id.trim()).filter(Boolean))];
  const accepted = new Map<string, OctoberProvenance[]>();
  if (ids.length === 0) return accepted;
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT r.artifact_id, r.state AS ref_state, r.source, r.source_id,
              r.source_revision, l.state AS ledger_state, l.revision AS current_revision,
              l.message_id, l.conversation_id, l.speaker, l.event_time
       FROM october_source_refs r
       LEFT JOIN october_source_ledger l
         ON l.namespace = r.namespace AND l.source = r.source AND l.source_id = r.source_id
       WHERE r.namespace = ? AND r.artifact_kind = ?
         AND r.artifact_id IN (${placeholders})
       ORDER BY r.artifact_id, r.source_id`
    )
    .bind(OCTOBER_NAMESPACE, kind, ...ids)
    .all<RefQueryRow>();

  const grouped = new Map<string, RefQueryRow[]>();
  for (const row of result.results ?? []) {
    const rows = grouped.get(row.artifact_id) ?? [];
    rows.push(row);
    grouped.set(row.artifact_id, rows);
  }
  for (const [artifactId, rows] of grouped) {
    const valid =
      rows.length > 0 &&
      rows.every(
        (row) =>
          row.ref_state === "active" &&
          row.ledger_state === "active" &&
          row.current_revision === row.source_revision &&
          Boolean(row.message_id && row.conversation_id && row.speaker && row.event_time)
      );
    if (!valid) continue;
    accepted.set(
      artifactId,
      rows.map((row) => ({
        namespace: OCTOBER_NAMESPACE,
        source: OCTOBER_SOURCE,
        source_id: row.source_id,
        revision: row.source_revision,
        current_revision: row.current_revision as number,
        state: "active",
        message_id: row.message_id as string,
        conversation_id: row.conversation_id as string,
        speaker: row.speaker as string,
        event_time: row.event_time as string
      }))
    );
  }
  return accepted;
}

interface ReviewDecisionRow {
  decision_id: string;
  candidate_id: string;
  action: "approve" | "discard";
  result_state: "active" | "deleted";
  result_artifact_id: string | null;
  request_sha256: string;
}

interface ReviewCandidateRow {
  id: string;
  namespace: string;
  type: string;
  content: string;
  fact_key: string | null;
  confidence: number;
  importance: number;
  tags: string | null;
  source_message_ids: string | null;
  source: string;
  status: string;
  target_memory_id: string | null;
}

export interface OctoberReviewInput {
  decisionId: string;
  candidateId: string;
  action: "approve" | "discard";
  content?: string;
  type?: string;
  factKey?: string | null;
  confidence?: number;
  importance?: number;
  tags?: string[];
  decisionNote?: string;
}

export interface OctoberReviewResult {
  decision_id: string;
  candidate_id: string;
  action: "approve" | "discard";
  result_state: "active" | "deleted";
  result_artifact_id: string | null;
  applied: boolean;
  duplicate: boolean;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function resultFromDecision(row: ReviewDecisionRow, duplicate: boolean): OctoberReviewResult {
  return {
    decision_id: row.decision_id,
    candidate_id: row.candidate_id,
    action: row.action,
    result_state: row.result_state,
    result_artifact_id: row.result_artifact_id,
    applied: !duplicate,
    duplicate
  };
}

async function existingDecision(
  db: D1Database,
  input: { decisionId: string; candidateId: string }
): Promise<ReviewDecisionRow | null> {
  return (
    (await db
      .prepare(
        `SELECT decision_id, candidate_id, action, result_state, result_artifact_id, request_sha256
         FROM october_review_decisions
         WHERE decision_id = ? OR (namespace = ? AND candidate_id = ?)
         LIMIT 1`
      )
      .bind(input.decisionId, OCTOBER_NAMESPACE, input.candidateId)
      .first<ReviewDecisionRow>()) ?? null
  );
}

export async function reviewOctoberCandidate(
  env: Env,
  input: OctoberReviewInput
): Promise<OctoberReviewResult> {
  const canonicalRequest = JSON.stringify({
    decision_id: input.decisionId,
    candidate_id: input.candidateId,
    action: input.action,
    content: input.content ?? null,
    type: input.type ?? null,
    fact_key: input.factKey ?? null,
    confidence: input.confidence ?? null,
    importance: input.importance ?? null,
    tags: input.tags ?? null,
    decision_note: input.decisionNote ?? null
  });
  const requestHash = await sha256Hex(canonicalRequest);
  const prior = await existingDecision(env.DB, input);
  if (prior) {
    if (
      prior.decision_id !== input.decisionId ||
      prior.candidate_id !== input.candidateId ||
      prior.action !== input.action ||
      prior.request_sha256 !== requestHash
    ) {
      throw new OctoberContractError("decision_conflict", "decision id or candidate was already used", 409);
    }
    return resultFromDecision(prior, true);
  }

  const candidate = await env.DB
    .prepare("SELECT * FROM memory_candidates WHERE namespace = ? AND id = ?")
    .bind(OCTOBER_NAMESPACE, input.candidateId)
    .first<ReviewCandidateRow>();
  if (!candidate) throw new OctoberContractError("candidate_not_found", "candidate not found", 404);
  if (candidate.status !== "pending") {
    throw new OctoberContractError("candidate_not_pending", "candidate is no longer pending", 409);
  }

  const stamp = nowIso();
  if (input.action === "discard") {
    const statements = [
      env.DB
        .prepare(
          `INSERT INTO october_review_decisions (
             decision_id, namespace, candidate_id, action, result_state,
             result_artifact_id, request_sha256, decided_at
           ) VALUES (?, ?, ?, 'discard', 'deleted', NULL, ?, ?)`
        )
        .bind(input.decisionId, OCTOBER_NAMESPACE, candidate.id, requestHash, stamp),
      env.DB
        .prepare(
          `UPDATE memory_candidates
           SET status = 'discarded', decision_note = ?, updated_at = ?
           WHERE namespace = ? AND id = ?`
        )
        .bind(input.decisionNote || "discarded", stamp, OCTOBER_NAMESPACE, candidate.id)
    ];
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const raced = await existingDecision(env.DB, input);
      if (raced && raced.request_sha256 === requestHash) return resultFromDecision(raced, true);
      dbError(error);
    }
    return {
      decision_id: input.decisionId,
      candidate_id: candidate.id,
      action: "discard",
      result_state: "deleted",
      result_artifact_id: null,
      applied: true,
      duplicate: false
    };
  }

  const sourceMessageIds = parseStringArray(candidate.source_message_ids);
  if (sourceMessageIds.length === 0) {
    throw new OctoberContractError("candidate_sources_not_current", "candidate has no source evidence", 409);
  }

  if (candidate.source === "dream_delete") {
    if (!candidate.target_memory_id) {
      throw new OctoberContractError("review_target_missing", "delete candidate has no target", 409);
    }
    const target = await env.DB
      .prepare("SELECT id, vector_id, status FROM memories WHERE namespace = ? AND id = ?")
      .bind(OCTOBER_NAMESPACE, candidate.target_memory_id)
      .first<{ id: string; vector_id: string | null; status: string }>();
    if (!target || target.status !== "active") {
      throw new OctoberContractError("review_target_not_active", "target memory is not active", 409);
    }
    const statements = [
      env.DB
        .prepare(
          `INSERT INTO october_review_decisions (
             decision_id, namespace, candidate_id, action, result_state,
             result_artifact_id, request_sha256, decided_at
           ) VALUES (?, ?, ?, 'approve', 'deleted', ?, ?, ?)`
        )
        .bind(
          input.decisionId,
          OCTOBER_NAMESPACE,
          candidate.id,
          target.id,
          requestHash,
          stamp
        ),
      env.DB
        .prepare(
          `UPDATE memories SET status = 'archived', updated_at = ?
           WHERE namespace = ? AND id = ?`
        )
        .bind(stamp, OCTOBER_NAMESPACE, target.id),
      env.DB.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(target.id),
      env.DB
        .prepare(
          `UPDATE memory_candidates
           SET status = 'approved', target_memory_id = ?, decision_note = ?, updated_at = ?
           WHERE namespace = ? AND id = ?`
        )
        .bind(
          target.id,
          input.decisionNote || "dream_delete approved",
          stamp,
          OCTOBER_NAMESPACE,
          candidate.id
        )
    ];
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const raced = await existingDecision(env.DB, input);
      if (raced && raced.request_sha256 === requestHash) return resultFromDecision(raced, true);
      dbError(error);
    }
    if (target.vector_id && env.VECTORIZE) {
      try {
        await env.VECTORIZE.deleteByIds([target.vector_id]);
      } catch (error) {
        console.error("october review vector cleanup pending", {
          memory_id: target.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      decision_id: input.decisionId,
      candidate_id: candidate.id,
      action: "approve",
      result_state: "deleted",
      result_artifact_id: target.id,
      applied: true,
      duplicate: false
    };
  }

  const target = candidate.target_memory_id
    ? await env.DB
        .prepare("SELECT * FROM memories WHERE namespace = ? AND id = ?")
        .bind(OCTOBER_NAMESPACE, candidate.target_memory_id)
        .first<{
          id: string;
          type: string;
          fact_key: string | null;
          vector_id: string | null;
          status: string;
        }>()
    : null;
  if (candidate.target_memory_id && (!target || target.status !== "active")) {
    throw new OctoberContractError(
      "review_target_not_active",
      "target memory is missing or inactive; fallback creation is forbidden",
      409
    );
  }

  const memoryId = await octoberReviewMemoryId(input.decisionId);
  const vectorId = `mem_${memoryId}`;
  const content = input.content?.trim() || candidate.content;
  const type = clampMemoryType(input.type || candidate.type, "note");
  const factKey = input.factKey === undefined ? candidate.fact_key : input.factKey;
  const confidence = input.confidence ?? candidate.confidence;
  const importance = input.importance ?? candidate.importance;
  const tags = input.tags ?? parseStringArray(candidate.tags);
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO memories (
           id, namespace, type, content, summary, importance, confidence, status,
           pinned, tags, source, source_message_ids, vector_id, created_at, updated_at,
           expires_at, fact_key, version_status, superseded_by, authored_by, response_tendency
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', 0, ?, 'review', ?, ?, ?, ?,
                   NULL, ?, 'current', NULL, NULL, NULL)`
      )
      .bind(
        memoryId,
        OCTOBER_NAMESPACE,
        type,
        content,
        importance,
        confidence,
        JSON.stringify(tags),
        JSON.stringify(sourceMessageIds),
        vectorId,
        stamp,
        stamp,
        factKey
      ),
    env.DB
      .prepare(
        `INSERT INTO memory_lifecycle (
           memory_id, namespace, fact_key, supersedes_id, superseded_by_id,
           review_reason, valid_as_of, last_seen_at, seen_count, last_injected_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 0, NULL)`
      )
      .bind(
        memoryId,
        OCTOBER_NAMESPACE,
        factKey,
        target?.id ?? null,
        input.decisionNote || "approved",
        stamp
      ),
    env.DB
      .prepare(
        `INSERT INTO october_review_decisions (
           decision_id, namespace, candidate_id, action, result_state,
           result_artifact_id, request_sha256, decided_at
         ) VALUES (?, ?, ?, 'approve', 'active', ?, ?, ?)`
      )
      .bind(
        input.decisionId,
        OCTOBER_NAMESPACE,
        candidate.id,
        memoryId,
        requestHash,
        stamp
      )
  ];
  if (target) {
    statements.push(
      env.DB
        .prepare(
          `UPDATE memories
           SET status = 'superseded', version_status = 'superseded', superseded_by = ?, updated_at = ?
           WHERE namespace = ? AND id = ?`
        )
        .bind(memoryId, stamp, OCTOBER_NAMESPACE, target.id),
      env.DB
        .prepare(
          `UPDATE memory_lifecycle
           SET superseded_by_id = ?, review_reason = ? WHERE memory_id = ?`
        )
        .bind(memoryId, input.decisionNote || "approve_update", target.id),
      env.DB.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(target.id)
    );
  }
  statements.push(
    env.DB
      .prepare(
        `UPDATE memory_candidates
         SET status = 'approved', target_memory_id = ?, decision_note = ?, updated_at = ?
         WHERE namespace = ? AND id = ?`
      )
      .bind(
        memoryId,
        input.decisionNote || (target ? "approve_update" : "approved"),
        stamp,
        OCTOBER_NAMESPACE,
        candidate.id
      )
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await existingDecision(env.DB, input);
    if (raced && raced.request_sha256 === requestHash) return resultFromDecision(raced, true);
    dbError(error);
  }

  const beforeFts = await currentArtifactProvenance(env.DB, "memory", [memoryId]);
  if (beforeFts.has(memoryId)) {
    const indexed = await upsertMemoryFts(env.DB, {
      namespace: OCTOBER_NAMESPACE,
      memoryId,
      content
    });
    if (indexed) {
      const afterFts = await currentArtifactProvenance(env.DB, "memory", [memoryId]);
      if (!afterFts.has(memoryId)) {
        await deleteFtsRow(env.DB, "memory_fts", "memory_id", memoryId);
      }
    }
  }
  const created = await getMemoryById(env.DB, { namespace: OCTOBER_NAMESPACE, id: memoryId });
  if (created) {
    try {
      const before = await currentArtifactProvenance(env.DB, "memory", [memoryId]);
      const embedded = before.has(memoryId) && await upsertMemoryEmbedding(env, created);
      if (embedded) {
        const after = await currentArtifactProvenance(env.DB, "memory", [memoryId]);
        if (!after.has(memoryId) && created.vector_id && env.VECTORIZE) {
          try {
            await env.VECTORIZE.deleteByIds([created.vector_id]);
          } catch (cleanupError) {
            await markArtifactCleanupPending(env.DB, "memory", memoryId);
            console.error("october late review vector cleanup pending", {
              memory_id: memoryId,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            });
          }
        }
      }
    } catch (error) {
      console.error("october approved memory vector upsert failed", {
        memory_id: memoryId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (target?.vector_id && env.VECTORIZE) {
    try {
      await env.VECTORIZE.deleteByIds([target.vector_id]);
    } catch (error) {
      console.error("october superseded vector cleanup pending", {
        memory_id: target.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    decision_id: input.decisionId,
    candidate_id: candidate.id,
    action: "approve",
    result_state: "active",
    result_artifact_id: memoryId,
    applied: true,
    duplicate: false
  };
}

export async function reconcileOctoberCleanup(
  env: Env,
  limit = 25
): Promise<{ scanned: number; completed: number; pending: number }> {
  const result = await env.DB
    .prepare(
      `SELECT * FROM october_source_ledger
       WHERE namespace = ? AND source = ? AND cleanup_state = 'pending'
       ORDER BY updated_at ASC LIMIT ?`
    )
    .bind(OCTOBER_NAMESPACE, OCTOBER_SOURCE, Math.min(Math.max(Math.floor(limit), 1), 100))
    .all<OctoberSourceLedgerRow>();
  let completed = 0;
  for (const row of result.results ?? []) {
    const artifacts = await cleanupArtifactsForSource(env.DB, row.source_id, row.revision);
    const event: OctoberSourceEvent = {
      contract_revision: OCTOBER_CONTRACT_REVISION,
      namespace: OCTOBER_NAMESPACE,
      source: OCTOBER_SOURCE,
      source_id: row.source_id,
      conversation_id: row.conversation_id,
      speaker: row.speaker as OctoberSourceEvent["speaker"],
      role: row.role,
      event_time: row.event_time,
      revision: row.revision,
      operation: row.operation,
      content: null,
      content_sha256: row.content_sha256,
      event_id: "reconcile",
      message_id: row.message_id
    };
    if ((await finishVectorCleanup(env, event, vectorIdsForCleanup(artifacts))) === "complete") {
      completed += 1;
    }
  }
  const scanned = result.results?.length ?? 0;
  return { scanned, completed, pending: scanned - completed };
}
