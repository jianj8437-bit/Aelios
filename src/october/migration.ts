import { clampMemoryType } from "../memory/canonicalTypes";
import { deleteFtsRow, upsertMemoryFts } from "../memory/fts";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { nowIso } from "../utils/time";
import {
  OCTOBER_CONTRACT_REVISION,
  OCTOBER_NAMESPACE,
  OCTOBER_SOURCE,
  OctoberContractError
} from "./contract";
import { currentArtifactProvenance } from "./store";

const MAX_BATCH_ITEMS = 25;
const MAX_SOURCE_REFS = 8;
const MAX_CONTENT_CHARS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

type OriginKind = "lmc5_current" | "lmc5_review";
type ArtifactKind = "memory" | "candidate";

interface SourceRef {
  source_id: string;
  revision: number;
}

interface MigrationItem {
  origin_kind: OriginKind;
  origin_id: string;
  content: string;
  type: string;
  fact_key: string | null;
  confidence: number;
  importance: number;
  tags: string[];
  source_refs: SourceRef[];
  created_at: string;
  updated_at: string;
}

interface MigrationItemRow {
  origin_kind: OriginKind;
  origin_id: string;
  artifact_kind: ArtifactKind;
  artifact_id: string;
  artifact_sha256: string;
  state: "active" | "rolled_back";
}

interface MigrationBatchRow {
  batch_id: string;
  payload_sha256: string;
  requested_items: number;
  state: "applied" | "rolled_back";
  created_at: string;
  updated_at: string;
}

function fail(code: string, message: string, status = 400): never {
  throw new OctoberContractError(code, message, status);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_migration", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string") fail("invalid_migration", `${field} must be a string`);
  const selected = value.trim();
  if (!selected || selected.length > max || (pattern && !pattern.test(selected))) {
    fail("invalid_migration", `${field} has an invalid value`);
  }
  return selected;
}

function timestamp(value: unknown, field: string): string {
  const selected = boundedString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(selected) || !Number.isFinite(Date.parse(selected))) {
    fail("invalid_migration", `${field} must be an ISO-8601 timestamp with a timezone`);
  }
  return selected;
}

function unitNumber(value: unknown, field: string, fallback: number): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected < 0 || selected > 1) {
    fail("invalid_migration", `${field} must be between 0 and 1`);
  }
  return selected;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, field, max);
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail("invalid_migration", "tags must contain at most 20 strings");
  return [...new Set(value.map((item, index) => boundedString(item, `tags[${index}]`, 80)))];
}

function normalizeSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_REFS) {
    fail("invalid_migration", `source_refs must contain 1-${MAX_SOURCE_REFS} entries`);
  }
  const refs = value.map((entry, index) => {
    const row = object(entry, `source_refs[${index}]`);
    const sourceId = boundedString(row.source_id, `source_refs[${index}].source_id`, 200, ID_PATTERN);
    if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) {
      fail("invalid_migration", `source_refs[${index}].revision must be a positive integer`);
    }
    return { source_id: sourceId, revision: row.revision as number };
  });
  refs.sort((left, right) => left.source_id.localeCompare(right.source_id) || left.revision - right.revision);
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.source_id}\n${ref.revision}`;
    if (seen.has(key)) fail("invalid_migration", "source_refs contains a duplicate");
    seen.add(key);
  }
  return refs;
}

function normalizeItem(value: unknown, index: number): MigrationItem {
  const row = object(value, `items[${index}]`);
  if (row.origin_kind !== "lmc5_current" && row.origin_kind !== "lmc5_review") {
    fail("invalid_migration", `items[${index}].origin_kind is invalid`);
  }
  if (typeof row.content !== "string" || row.content.length < 1 || row.content.length > MAX_CONTENT_CHARS) {
    fail("invalid_migration", `items[${index}].content must contain 1-${MAX_CONTENT_CHARS} characters`);
  }
  return {
    origin_kind: row.origin_kind,
    origin_id: boundedString(row.origin_id, `items[${index}].origin_id`, 160, ID_PATTERN),
    content: row.content,
    type: boundedString(row.type ?? "note", `items[${index}].type`, 64),
    fact_key: optionalString(row.fact_key, `items[${index}].fact_key`, 240),
    confidence: unitNumber(row.confidence, `items[${index}].confidence`, 0.8),
    importance: unitNumber(row.importance, `items[${index}].importance`, 0.5),
    tags: normalizeTags(row.tags),
    source_refs: normalizeSourceRefs(row.source_refs),
    created_at: timestamp(row.created_at, `items[${index}].created_at`),
    updated_at: timestamp(row.updated_at, `items[${index}].updated_at`)
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function artifactId(kind: OriginKind, originId: string): Promise<string> {
  const hash = await sha256Hex(`${OCTOBER_CONTRACT_REVISION}\nmigration\n${kind}\n${originId}`);
  return `${kind === "lmc5_current" ? "xhmem" : "xhcand"}_${hash.slice(0, 48)}`;
}

async function sourceMessageIds(db: D1Database, refs: SourceRef[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    const row = await db
      .prepare(
        `SELECT message_id FROM october_source_ledger
         WHERE namespace = ? AND source = ? AND source_id = ?
           AND revision = ? AND state = 'active'`
      )
      .bind(OCTOBER_NAMESPACE, OCTOBER_SOURCE, ref.source_id, ref.revision)
      .first<{ message_id: string }>();
    if (!row) fail("migration_source_not_current", "a migration source is missing, stale, or tombstoned", 409);
    ids.push(row.message_id);
  }
  return [...new Set(ids)].sort();
}

function response(batch: MigrationBatchRow, duplicate: boolean, ftsIndexed = 0) {
  return {
    batch_id: batch.batch_id,
    contract_revision: OCTOBER_CONTRACT_REVISION,
    namespace: OCTOBER_NAMESPACE,
    state: batch.state,
    items: batch.requested_items,
    applied: !duplicate,
    duplicate,
    fts_indexed: ftsIndexed
  };
}

export async function applyOctoberMigrationBatch(env: Env, value: unknown) {
  const input = object(value, "migration batch");
  const batchId = boundedString(input.batch_id, "batch_id", 120, ID_PATTERN);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_BATCH_ITEMS) {
    fail("invalid_migration", `items must contain 1-${MAX_BATCH_ITEMS} entries`);
  }
  const items = input.items.map(normalizeItem).sort((left, right) =>
    left.origin_kind.localeCompare(right.origin_kind) || left.origin_id.localeCompare(right.origin_id)
  );
  const uniqueOrigins = new Set(items.map((item) => `${item.origin_kind}\n${item.origin_id}`));
  if (uniqueOrigins.size !== items.length) fail("invalid_migration", "items contains a duplicate origin");
  const payloadSha = await sha256Hex(canonical({ batch_id: batchId, items }));
  const existing = await env.DB
    .prepare("SELECT * FROM october_migration_batches WHERE batch_id = ?")
    .bind(batchId)
    .first<MigrationBatchRow>();
  if (existing) {
    if (existing.payload_sha256 !== payloadSha || existing.state !== "applied") {
      fail("migration_batch_conflict", "batch id was already used for a different or rolled-back batch", 409);
    }
    return response(existing, true);
  }

  const prepared = [] as Array<{
    item: MigrationItem;
    artifact_kind: ArtifactKind;
    artifact_id: string;
    artifact_sha256: string;
    source_message_ids: string[];
  }>;
  for (const item of items) {
    const prior = await env.DB
      .prepare(
        `SELECT batch_id FROM october_migration_items
         WHERE namespace = ? AND origin_kind = ? AND origin_id = ?`
      )
      .bind(OCTOBER_NAMESPACE, item.origin_kind, item.origin_id)
      .first<{ batch_id: string }>();
    if (prior) fail("migration_origin_conflict", "a legacy origin was already migrated", 409);
    prepared.push({
      item,
      artifact_kind: item.origin_kind === "lmc5_current" ? "memory" : "candidate",
      artifact_id: await artifactId(item.origin_kind, item.origin_id),
      artifact_sha256: await sha256Hex(item.content),
      source_message_ids: await sourceMessageIds(env.DB, item.source_refs)
    });
  }

  const stamp = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO october_migration_batches (
         batch_id, namespace, contract_revision, payload_sha256,
         requested_items, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`
    ).bind(batchId, OCTOBER_NAMESPACE, OCTOBER_CONTRACT_REVISION, payloadSha, items.length, stamp, stamp)
  ];
  for (const entry of prepared) {
    const item = entry.item;
    const sourceJson = JSON.stringify(entry.source_message_ids);
    if (entry.artifact_kind === "memory") {
      const type = clampMemoryType(item.type, "note");
      statements.push(
        env.DB.prepare(
          `INSERT INTO memories (
             id, namespace, type, content, summary, importance, confidence, status,
             pinned, tags, source, source_message_ids, vector_id, created_at, updated_at,
             expires_at, fact_key, version_status, superseded_by, authored_by, response_tendency
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', 0, ?, 'migration:lmc5-current',
                     ?, NULL, ?, ?, NULL, ?, 'current', NULL, NULL, NULL)`
        ).bind(
          entry.artifact_id, OCTOBER_NAMESPACE, type, item.content, item.importance,
          item.confidence, JSON.stringify(item.tags), sourceJson, item.created_at,
          item.updated_at, item.fact_key
        ),
        env.DB.prepare(
          `INSERT INTO memory_lifecycle (
             memory_id, namespace, fact_key, supersedes_id, superseded_by_id,
             review_reason, valid_as_of, last_seen_at, seen_count, last_injected_at
           ) VALUES (?, ?, ?, NULL, NULL, 'migrated_from_lmc5_current', ?, ?, 0, NULL)`
        ).bind(entry.artifact_id, OCTOBER_NAMESPACE, item.fact_key, item.created_at, item.updated_at)
      );
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO memory_candidates (
             id, namespace, type, content, fact_key, confidence, importance, tags,
             source_message_ids, source, status, target_memory_id, decision_note,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration:lmc5-review', 'pending',
                     NULL, 'migrated_from_lmc5_review', ?, ?)`
        ).bind(
          entry.artifact_id, OCTOBER_NAMESPACE, clampMemoryType(item.type, "note"),
          item.content, item.fact_key, item.confidence, item.importance,
          JSON.stringify(item.tags), sourceJson, item.created_at, item.updated_at
        )
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO october_migration_items (
           batch_id, namespace, origin_kind, origin_id, artifact_kind, artifact_id,
           artifact_sha256, source_refs_json, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(
        batchId, OCTOBER_NAMESPACE, item.origin_kind, item.origin_id,
        entry.artifact_kind, entry.artifact_id, entry.artifact_sha256,
        JSON.stringify(item.source_refs), stamp, stamp
      )
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    throw new OctoberContractError(
      "migration_apply_failed",
      error instanceof Error ? error.message : "migration batch failed",
      409
    );
  }

  let ftsIndexed = 0;
  for (const entry of prepared) {
    if (entry.artifact_kind !== "memory") continue;
    const before = await currentArtifactProvenance(env.DB, "memory", [entry.artifact_id]);
    if (!before.has(entry.artifact_id)) continue;
    const indexed = await upsertMemoryFts(env.DB, {
      namespace: OCTOBER_NAMESPACE,
      memoryId: entry.artifact_id,
      content: entry.item.content
    });
    if (!indexed) continue;
    const after = await currentArtifactProvenance(env.DB, "memory", [entry.artifact_id]);
    if (!after.has(entry.artifact_id)) {
      await deleteFtsRow(env.DB, "memory_fts", "memory_id", entry.artifact_id);
      continue;
    }
    ftsIndexed += 1;
  }
  return response({
    batch_id: batchId,
    payload_sha256: payloadSha,
    requested_items: items.length,
    state: "applied",
    created_at: stamp,
    updated_at: stamp
  }, false, ftsIndexed);
}

export async function rollbackOctoberMigrationBatch(env: Env, batchIdValue: unknown) {
  const batchId = boundedString(batchIdValue, "batch_id", 120, ID_PATTERN);
  const batch = await env.DB
    .prepare("SELECT * FROM october_migration_batches WHERE batch_id = ?")
    .bind(batchId)
    .first<MigrationBatchRow>();
  if (!batch) fail("migration_batch_not_found", "migration batch was not found", 404);
  if (batch.state === "rolled_back") return response(batch, true);

  const result = await env.DB
    .prepare(
      `SELECT origin_kind, origin_id, artifact_kind, artifact_id, artifact_sha256, state
       FROM october_migration_items WHERE batch_id = ? ORDER BY artifact_kind, artifact_id`
    )
    .bind(batchId)
    .all<MigrationItemRow>();
  const items = result.results ?? [];
  if (items.length !== batch.requested_items) fail("migration_batch_incomplete", "migration ledger is incomplete", 409);
  for (const item of items) {
    if (item.state !== "active") fail("migration_item_conflict", "migration item is not active", 409);
    if (item.artifact_kind === "memory") {
      const row = await env.DB
        .prepare("SELECT content, status, source FROM memories WHERE namespace = ? AND id = ?")
        .bind(OCTOBER_NAMESPACE, item.artifact_id)
        .first<{ content: string; status: string; source: string | null }>();
      if (!row || row.status !== "active" || row.source !== "migration:lmc5-current" || await sha256Hex(row.content) !== item.artifact_sha256) {
        fail("migration_item_conflict", "a migrated memory changed after import", 409);
      }
    } else {
      const row = await env.DB
        .prepare("SELECT content, status, source FROM memory_candidates WHERE namespace = ? AND id = ?")
        .bind(OCTOBER_NAMESPACE, item.artifact_id)
        .first<{ content: string; status: string; source: string }>();
      if (!row || row.status !== "pending" || row.source !== "migration:lmc5-review" || await sha256Hex(row.content) !== item.artifact_sha256) {
        fail("migration_item_conflict", "a migrated review candidate changed after import", 409);
      }
    }
  }

  const stamp = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    if (item.artifact_kind === "memory") {
      statements.push(
        env.DB.prepare(
          `UPDATE memories SET status = 'archived', version_status = 'superseded', updated_at = ?
           WHERE namespace = ? AND id = ?`
        ).bind(stamp, OCTOBER_NAMESPACE, item.artifact_id),
        env.DB.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(item.artifact_id)
      );
    } else {
      statements.push(
        env.DB.prepare(
          `UPDATE memory_candidates SET status = 'discarded', decision_note = 'migration_rollback', updated_at = ?
           WHERE namespace = ? AND id = ?`
        ).bind(stamp, OCTOBER_NAMESPACE, item.artifact_id)
      );
    }
    statements.push(
      env.DB.prepare(
        "UPDATE october_migration_items SET state = 'rolled_back', updated_at = ? WHERE batch_id = ? AND origin_kind = ? AND origin_id = ?"
      ).bind(stamp, batchId, item.origin_kind, item.origin_id)
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE october_migration_batches SET state = 'rolled_back', updated_at = ? WHERE batch_id = ?"
    ).bind(stamp, batchId)
  );
  await env.DB.batch(statements);
  return response({ ...batch, state: "rolled_back", updated_at: stamp }, false);
}

export async function getOctoberMigrationBatch(env: Env, batchIdValue: unknown) {
  const batchId = boundedString(batchIdValue, "batch_id", 120, ID_PATTERN);
  const batch = await env.DB
    .prepare("SELECT * FROM october_migration_batches WHERE batch_id = ?")
    .bind(batchId)
    .first<MigrationBatchRow>();
  if (!batch) fail("migration_batch_not_found", "migration batch was not found", 404);
  const counts = await env.DB
    .prepare(
      `SELECT state, artifact_kind, count(*) AS count FROM october_migration_items
       WHERE batch_id = ? GROUP BY state, artifact_kind ORDER BY state, artifact_kind`
    )
    .bind(batchId)
    .all<{ state: string; artifact_kind: string; count: number }>();
  return { ...response(batch, true), counts: counts.results ?? [] };
}
