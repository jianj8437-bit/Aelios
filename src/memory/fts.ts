import { tokenizeForIndex } from "./queryShape";
import { cleanMessageText } from "../utils/sanitize";

const FTS_WRITE_ATTEMPTS = 3;

function isMissingFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|module)|fts5/i.test(message);
}

export function toFtsBody(text: string): string {
  return tokenizeForIndex(text).join(" ");
}

export function toFtsMatch(tokens: string[]): string {
  const unique = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length >= 2))];
  return unique
    .map((token) => `"${token.replace(/["*]/g, "")}"`)
    .filter((token) => token.length > 2)
    .slice(0, 12)
    .join(" OR ");
}

async function withRetry<T>(fn: () => Promise<T>, label: string, meta: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < FTS_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (isMissingFtsError(error) || attempt === FTS_WRITE_ATTEMPTS - 1) {
        if (!isMissingFtsError(error)) console.error(label, { ...meta, attempt: attempt + 1, error });
        break;
      }
    }
  }
  throw last;
}

export async function deleteFtsRow(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  id: string
): Promise<void> {
  try {
    await withRetry(
      () => db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(id).run(),
      "fts delete failed",
      { table, id }
    );
  } catch {
    // Search already falls back to LIKE; a stale row is worse than a missing one only if content changed.
  }
}

export async function upsertMessageFts(
  db: D1Database,
  input: { namespace: string; messageId: string; content: string; fresh?: boolean }
): Promise<boolean> {
  const body = toFtsBody(cleanMessageText(input.content));
  if (!body) return false;
  try {
    await withRetry(async () => {
      // message_id is UNINDEXED in FTS5, so this delete reads every row of message_fts. A caller
      // whose id cannot have a row yet (`fresh`) skips it.
      if (!input.fresh) {
        await db.prepare("DELETE FROM message_fts WHERE message_id = ?").bind(input.messageId).run();
      }
      await db
        .prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES (?, ?, ?)")
        .bind(body, input.namespace, input.messageId)
        .run();
    }, "message fts index failed", { id: input.messageId });
    return true;
  } catch (error) {
    if (!isMissingFtsError(error)) console.error("message fts index failed", { id: input.messageId, error });
    return false;
  }
}

export async function upsertMemoryFts(
  db: D1Database,
  input: { namespace: string; memoryId: string; content: string }
): Promise<boolean> {
  const body = toFtsBody(input.content);
  if (!body) return false;
  try {
    await withRetry(async () => {
      await db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(input.memoryId).run();
      await db
        .prepare("INSERT INTO memory_fts (fts_body, namespace, memory_id) VALUES (?, ?, ?)")
        .bind(body, input.namespace, input.memoryId)
        .run();
    }, "memory fts index failed", { id: input.memoryId });
    return true;
  } catch (error) {
    if (!isMissingFtsError(error)) console.error("memory fts index failed", { id: input.memoryId, error });
    return false;
  }
}

export async function searchFtsIds(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  input: { namespace: string; tokens: string[]; limit: number }
): Promise<string[]> {
  const match = toFtsMatch(input.tokens);
  if (!match) return [];
  try {
    const result = await db
      .prepare(
        `SELECT ${idColumn} AS id FROM ${table}
         WHERE ${table} MATCH ? AND namespace = ?
         ORDER BY bm25(${table})
         LIMIT ?`
      )
      .bind(match, input.namespace, input.limit)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id).filter(Boolean);
  } catch (rankedError) {
    if (isMissingFtsError(rankedError)) return [];
    try {
      const result = await db
        .prepare(
          `SELECT ${idColumn} AS id FROM ${table}
           WHERE ${table} MATCH ? AND namespace = ?
           LIMIT ?`
        )
        .bind(match, input.namespace, input.limit)
        .all<{ id: string }>();
      return (result.results ?? []).map((row) => row.id).filter(Boolean);
    } catch (error) {
      if (!isMissingFtsError(error)) console.error("fts search failed", { table, error, rankedError });
      return [];
    }
  }
}

export interface FtsBackfillResult {
  messagesIndexed: number;
  memoriesIndexed: number;
  messageOrphansPurged: number;
  memoryOrphansPurged: number;
  failed: number;
}

async function indexMissingMessages(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content
       FROM messages m
       LEFT JOIN message_fts f ON f.message_id = m.id
       WHERE m.namespace = ? AND f.message_id IS NULL
         AND m.role IN ('user', 'assistant')
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content
       FROM messages m
       LEFT JOIN message_fts f ON f.message_id = m.id
       WHERE f.message_id IS NULL AND m.role IN ('user', 'assistant')
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string }>();

  let indexed = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const ok = await upsertMessageFts(db, { namespace: row.namespace, messageId: row.id, content: row.content });
    if (ok) indexed += 1;
    else failed += 1;
  }
  return { indexed, failed };
}

async function indexMissingMemories(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content, m.summary
       FROM memories m
       LEFT JOIN memory_fts f ON f.memory_id = m.id
       WHERE m.namespace = ? AND f.memory_id IS NULL
         AND m.status = 'active'
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content, m.summary
       FROM memories m
       LEFT JOIN memory_fts f ON f.memory_id = m.id
       WHERE f.memory_id IS NULL AND m.status = 'active'
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>();

  let indexed = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const ok = await upsertMemoryFts(db, {
      namespace: row.namespace,
      memoryId: row.id,
      content: `${row.content}\n${row.summary ?? ""}`
    });
    if (ok) indexed += 1;
    else failed += 1;
  }
  return { indexed, failed };
}

export async function purgeOrphanFts(db: D1Database): Promise<{ messages: number; memories: number }> {
  let messages = 0;
  let memories = 0;
  try {
    const msg = await db.prepare(
      "DELETE FROM message_fts WHERE message_id NOT IN (SELECT id FROM messages)"
    ).run();
    messages = msg.meta.changes ?? 0;
  } catch (error) {
    console.error("message fts orphan purge failed", error);
  }
  try {
    const mem = await db.prepare(
      `DELETE FROM memory_fts WHERE memory_id NOT IN (SELECT id FROM memories WHERE status = 'active')`
    ).run();
    memories = mem.meta.changes ?? 0;
  } catch (error) {
    console.error("memory fts orphan purge failed", error);
  }
  return { messages, memories };
}

export async function backfillFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  let messagesIndexed = 0;
  let memoriesIndexed = 0;
  let failed = 0;
  try {
    const messages = await indexMissingMessages(db, { namespace: input.namespace, limit });
    messagesIndexed = messages.indexed;
    failed += messages.failed;
  } catch (error) {
    console.error("message fts backfill failed", error);
  }
  try {
    const memories = await indexMissingMemories(db, { namespace: input.namespace, limit });
    memoriesIndexed = memories.indexed;
    failed += memories.failed;
  } catch (error) {
    console.error("memory fts backfill failed", error);
  }
  const purged = await purgeOrphanFts(db);
  return {
    messagesIndexed,
    memoriesIndexed,
    messageOrphansPurged: purged.messages,
    memoryOrphansPurged: purged.memories,
    failed
  };
}

export async function rebuildFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  try {
    if (input.namespace) {
      await db.prepare("DELETE FROM message_fts WHERE namespace = ?").bind(input.namespace).run();
      await db.prepare("DELETE FROM memory_fts WHERE namespace = ?").bind(input.namespace).run();
    } else {
      await db.prepare("DELETE FROM message_fts").run();
      await db.prepare("DELETE FROM memory_fts").run();
    }
  } catch (error) {
    console.error("fts rebuild truncate failed", error);
  }
  return backfillFts(db, input);
}
