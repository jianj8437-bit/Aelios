import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import {
  handleOctoberBoot,
  handleOctoberCandidateReview,
  handleOctoberDerivedList,
  handleOctoberDiary,
  handleOctoberMigration,
  handleOctoberRecall,
  handleOctoberReconcile,
  handleOctoberSourceEvent
} from "../src/api/october";
import {
  OCTOBER_CONTRACT_REVISION,
  OCTOBER_NAMESPACE,
  OCTOBER_SOURCE
} from "../src/october/contract";
import { currentArtifactProvenance } from "../src/october/store";
import { sha256Hex } from "../src/utils/hash";
import { handleHealth } from "../src/api/health";

function wrapSqlite(sqlite: DatabaseSync) {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: any[] = [];
      const api = {
        bind(...values: any[]) {
          args = values;
          return api;
        },
        async all() {
          return { results: statement.all(...args) };
        },
        async first() {
          return statement.get(...args) || null;
        },
        async run() {
          const result = statement.run(...args);
          return { meta: { changes: result.changes } };
        }
      };
      return api;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const db = wrapSqlite(sqlite);
  const env = {
    DB: db,
    OCTOBER_XH_SOURCE_CONTRACT: OCTOBER_CONTRACT_REVISION,
    OCTOBER_XH_SOURCE_API_KEY: "synthetic-source-key",
    OCTOBER_XH_ADMIN_API_KEY: "synthetic-admin-key",
    OCTOBER_XH_SOURCE_CODE_URL: `https://github.com/jianj8437-bit/Aelios/tree/${"a".repeat(40)}`,
    MEMORY_LIFECYCLE_ENABLED: "true",
    RECALL_REQUIRE_D1_BACKING: "true",
    CANDIDATE_JUDGE_ENABLED: "false",
    ENABLE_MEMORY_FILTER: "false",
    ENABLE_MEMORY_RERANKER: "false"
  } as any;
  return { sqlite, db, env };
}

function pauseNextFtsInsert(env: any, table: "message_fts" | "memory_fts") {
  const original = env.DB;
  let armed = true;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  env.DB = {
    ...original,
    prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!armed || !sql.includes(`INSERT INTO ${table}`)) return statement;
      armed = false;
      let bound = statement;
      const wrapped = {
        bind(...values: any[]) {
          bound = statement.bind(...values);
          return wrapped;
        },
        all: () => bound.all(),
        first: () => bound.first(),
        async run() {
          markStarted();
          await gate;
          return bound.run();
        }
      };
      return wrapped;
    }
  };
  return { started, release };
}

type EventInput = {
  source_id: string;
  conversation_id: string;
  speaker: "participant:user" | "participant:gu-chen" | "agent:xu-heng";
  role: "user" | "assistant";
  event_time: string;
  revision: number;
  operation: "upsert" | "delete";
  content?: string | null;
};

async function sourceEvent(input: EventInput) {
  const contentSha = input.operation === "upsert" ? await sha256Hex(input.content as string) : null;
  const fingerprint = [
    OCTOBER_CONTRACT_REVISION,
    OCTOBER_NAMESPACE,
    OCTOBER_SOURCE,
    input.source_id,
    String(input.revision),
    input.operation,
    input.conversation_id,
    input.speaker,
    input.role,
    input.event_time,
    contentSha ?? ""
  ].join("\n");
  return {
    contract_revision: OCTOBER_CONTRACT_REVISION,
    source: OCTOBER_SOURCE,
    source_id: input.source_id,
    conversation_id: input.conversation_id,
    speaker: input.speaker,
    role: input.role,
    event_time: input.event_time,
    revision: input.revision,
    operation: input.operation,
    content: input.operation === "upsert" ? input.content : null,
    content_sha256: contentSha,
    event_id: `xhsrc_${await sha256Hex(fingerprint)}`
  };
}

function request(path: string, key: string, body: unknown, method = "POST") {
  return new Request(`https://october.invalid${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function responseJson(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

const firstInput: EventInput = {
  source_id: "synthetic/message-001",
  conversation_id: "xh:synthetic:room-01",
  speaker: "participant:user",
  role: "user",
  event_time: "2026-01-02T08:30:00+08:00",
  revision: 1,
  operation: "upsert",
  content: "合成故事里，小北答应周末带一把蓝伞。"
};

async function ingest(env: any, event: unknown, key = "synthetic-source-key") {
  const response = await handleOctoberSourceEvent(
    request("/v1/october/source-events", key, event),
    env
  );
  return { response, body: await responseJson(response) };
}

async function migrate(env: any, path: string, body: unknown, key = "synthetic-admin-key") {
  const response = await handleOctoberMigration(request(path, key, body), env);
  return { response, body: await responseJson(response) };
}

test("October-only health requires dedicated contract secrets, not the generic chat key", async () => {
  const { sqlite, env } = setup();
  try {
    env.AI = {};
    env.VECTORIZE = {};
    env.MEMORY_QUEUE = {};
    const healthy = await responseJson(handleHealth(env));
    assert.equal(healthy.ok, true);
    assert.deepEqual(healthy.missing_text_vars, []);

    delete env.OCTOBER_XH_ADMIN_API_KEY;
    const missingAdmin = await responseJson(handleHealth(env));
    assert.equal(missingAdmin.ok, false);
    assert.deepEqual(missingAdmin.missing_text_vars, ["OCTOBER_XH_ADMIN_API_KEY"]);
    assert.equal(missingAdmin.missing_text_vars.includes("CHATBOX_API_KEY"), false);

    env.OCTOBER_XH_ADMIN_API_KEY = "synthetic-admin-key";
    delete env.OCTOBER_XH_SOURCE_CODE_URL;
    const missingSourceOffer = await responseJson(handleHealth(env));
    assert.equal(missingSourceOffer.ok, false);
    assert.deepEqual(missingSourceOffer.missing_text_vars, ["OCTOBER_XH_SOURCE_CODE_URL"]);
  } finally {
    sqlite.close();
  }
});

test("isolated worker exposes commit-pinned Corresponding Source on every response", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const expected = env.OCTOBER_XH_SOURCE_CODE_URL;
  const source = await worker.fetch(
    new Request("https://october.invalid/source"),
    env,
    { waitUntil() {} } as any
  );
  assert.equal(source.status, 200);
  assert.equal((await responseJson(source)).source_code_url, expected);
  assert.equal(source.headers.get("link"), `<${expected}>; rel="source"`);

  const denied = await worker.fetch(
    request("/v1/october/source-events", "wrong-key", {}),
    env,
    { waitUntil() {} } as any
  );
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("link"), `<${expected}>; rel="source"`);
});

test("source endpoint fixes identity, preserves exact metadata, and is idempotent", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);

  const unauthorized = await ingest(env, first, "wrong-key");
  assert.equal(unauthorized.response.status, 401);

  const applied = await ingest(env, first);
  assert.equal(applied.response.status, 200);
  assert.deepEqual(
    {
      contract_revision: applied.body.data.contract_revision,
      namespace: applied.body.data.namespace,
      source: applied.body.data.source,
      revision: applied.body.data.revision,
      state: applied.body.data.state,
      applied: applied.body.data.applied
    },
    {
      contract_revision: OCTOBER_CONTRACT_REVISION,
      namespace: OCTOBER_NAMESPACE,
      source: OCTOBER_SOURCE,
      revision: 1,
      state: "active",
      applied: true
    }
  );
  const duplicate = await ingest(env, first);
  assert.equal(duplicate.body.data.duplicate, true);

  const counts = sqlite.prepare(
    `SELECT
      (SELECT count(*) FROM messages) AS messages,
      (SELECT count(*) FROM october_source_ledger) AS sources,
      (SELECT count(*) FROM october_source_events) AS events`
  ).get() as any;
  assert.deepEqual(
    { messages: counts.messages, sources: counts.sources, events: counts.events },
    { messages: 1, sources: 1, events: 1 }
  );
  const message = sqlite.prepare("SELECT * FROM messages").get() as any;
  // The message table holds the same instant in UTC (upstream compares it with UTC day ranges as text);
  // the ledger keeps the source's exact event_time.
  assert.equal(message.created_at, new Date(firstInput.event_time).toISOString());
  assert.equal(message.role, firstInput.role);
  const ledger = sqlite.prepare("SELECT * FROM october_source_ledger").get() as any;
  assert.equal(ledger.event_time, firstInput.event_time);
  assert.equal(ledger.speaker, firstInput.speaker);
  assert.equal(ledger.conversation_id, firstInput.conversation_id);

  const sameText = await sourceEvent({ ...firstInput, source_id: "synthetic/message-002" });
  assert.equal((await ingest(env, sameText)).response.status, 200);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n, 2);

  const foreign = { ...first, namespace: "someone-else" };
  assert.equal((await ingest(env, foreign)).response.status, 403);
  const gap = await sourceEvent({ ...firstInput, source_id: "synthetic/message-gap", revision: 2 });
  assert.equal((await ingest(env, gap)).body.error.code, "revision_gap");

  const changedMetadata = await sourceEvent({
    ...firstInput,
    revision: 2,
    event_time: "2026-01-02T08:31:00+08:00",
    content: "更正内容"
  });
  assert.equal((await ingest(env, changedMetadata)).body.error.code, "metadata_conflict");
  const systemRole = { ...first, role: "system" };
  assert.equal((await ingest(env, systemRole)).body.error.code, "speaker_role_mismatch");
});

test("bounded legacy migration preserves current/review states and rolls back independently", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);

  const batch = {
    batch_id: "synthetic-batch-001",
    items: [
      {
        origin_kind: "lmc5_current",
        origin_id: "memory-101",
        content: "合成的正式关系记忆，不来自任何真实对话。",
        type: "relationship",
        fact_key: "synthetic.relationship.101",
        confidence: 0.91,
        importance: 0.88,
        tags: ["synthetic", "migration"],
        source_refs: [{ source_id: firstInput.source_id, revision: 1 }],
        created_at: "2026-01-03T08:00:00+08:00",
        updated_at: "2026-01-04T08:00:00+08:00"
      },
      {
        origin_kind: "lmc5_review",
        origin_id: "memory-102",
        content: "合成的候审关系记忆，仍然需要人工决定。",
        type: "relationship",
        fact_key: null,
        confidence: 0.72,
        importance: 0.76,
        tags: ["synthetic", "review"],
        source_refs: [{ source_id: firstInput.source_id, revision: 1 }],
        created_at: "2026-01-05T08:00:00+08:00",
        updated_at: "2026-01-05T09:00:00+08:00"
      }
    ]
  };

  const unauthorized = await migrate(env, "/v1/october/migrations", batch, "synthetic-source-key");
  assert.equal(unauthorized.response.status, 401);
  const applied = await migrate(env, "/v1/october/migrations", batch);
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.data.state, "applied");
  assert.equal(applied.body.data.items, 2);
  assert.equal(applied.body.data.duplicate, false);
  assert.equal(applied.body.data.fts_indexed, 1);

  const memory = sqlite.prepare(
    "SELECT id,status,source,version_status,source_message_ids FROM memories WHERE source='migration:lmc5-current'"
  ).get() as any;
  const candidate = sqlite.prepare(
    "SELECT id,status,source,source_message_ids FROM memory_candidates WHERE source='migration:lmc5-review'"
  ).get() as any;
  assert.equal(memory.status, "active");
  assert.equal(memory.version_status, "current");
  assert.equal(candidate.status, "pending");
  assert.deepEqual(JSON.parse(memory.source_message_ids), [JSON.parse(candidate.source_message_ids)[0]]);
  assert.equal((sqlite.prepare(
    "SELECT count(*) AS n FROM october_source_refs WHERE state IN ('active','pending')"
  ).get() as any).n, 2);

  const duplicate = await migrate(env, "/v1/october/migrations", batch);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.data.duplicate, true);
  const reusedBatch = await migrate(env, "/v1/october/migrations", {
    ...batch,
    items: [{ ...batch.items[0], content: "同一批次不能偷偷换正文。" }]
  });
  assert.equal(reusedBatch.response.status, 409);
  assert.equal(reusedBatch.body.error.code, "migration_batch_conflict");
  const reusedOrigin = await migrate(env, "/v1/october/migrations", {
    batch_id: "synthetic-batch-002",
    items: [batch.items[0]]
  });
  assert.equal(reusedOrigin.response.status, 409);
  assert.equal(reusedOrigin.body.error.code, "migration_origin_conflict");

  const statusResponse = await handleOctoberMigration(new Request(
    "https://october.invalid/v1/october/migrations/synthetic-batch-001",
    { headers: { authorization: "Bearer synthetic-admin-key" } }
  ), env);
  assert.equal(statusResponse.status, 200);
  const statusBody = await responseJson(statusResponse);
  assert.deepEqual(statusBody.data.counts.map((row: any) => [row.state, row.artifact_kind, row.count]), [
    ["active", "candidate", 1],
    ["active", "memory", 1]
  ]);

  const rolledBack = await migrate(
    env,
    "/v1/october/migrations/synthetic-batch-001/rollback",
    {}
  );
  assert.equal(rolledBack.response.status, 200);
  assert.equal(rolledBack.body.data.state, "rolled_back");
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(memory.id) as any).status, "archived");
  assert.equal((sqlite.prepare("SELECT status FROM memory_candidates WHERE id = ?").get(candidate.id) as any).status, "discarded");
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_id = ?").get(memory.id) as any).n, 0);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM october_source_refs WHERE state IN ('active','pending')").get() as any).n, 0);
  const duplicateRollback = await migrate(
    env,
    "/v1/october/migrations/synthetic-batch-001/rollback",
    {}
  );
  assert.equal(duplicateRollback.body.data.duplicate, true);
});

test("legacy migration rejects stale sources, oversized batches, and changed artifacts on rollback", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  await ingest(env, first);
  const item = {
    origin_kind: "lmc5_current",
    origin_id: "memory-201",
    content: "纯合成迁移卡。",
    type: "note",
    source_refs: [{ source_id: firstInput.source_id, revision: 1 }],
    created_at: "2026-01-05T08:00:00Z",
    updated_at: "2026-01-05T08:00:00Z"
  };
  const tooMany = await migrate(env, "/v1/october/migrations", {
    batch_id: "too-many",
    items: Array.from({ length: 26 }, (_, index) => ({ ...item, origin_id: `memory-${index}` }))
  });
  assert.equal(tooMany.response.status, 400);
  const stale = await migrate(env, "/v1/october/migrations", {
    batch_id: "stale-source",
    items: [{ ...item, origin_id: "memory-stale", source_refs: [{ source_id: firstInput.source_id, revision: 2 }] }]
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "migration_source_not_current");

  const applied = await migrate(env, "/v1/october/migrations", {
    batch_id: "changed-artifact",
    items: [item]
  });
  assert.equal(applied.response.status, 200);
  const memory = sqlite.prepare("SELECT id FROM memories WHERE source='migration:lmc5-current'").get() as any;
  sqlite.prepare("UPDATE memories SET content='changed after migration' WHERE id=?").run(memory.id);
  const rollback = await migrate(
    env,
    "/v1/october/migrations/changed-artifact/rollback",
    {}
  );
  assert.equal(rollback.response.status, 409);
  assert.equal(rollback.body.error.code, "migration_item_conflict");
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE id=?").get(memory.id) as any).status, "active");
});

test("source edit racing migration FTS cannot leave a searchable stale memory", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  await ingest(env, first);
  const gate = pauseNextFtsInsert(env, "memory_fts");
  const applying = migrate(env, "/v1/october/migrations", {
    batch_id: "migration-fts-race",
    items: [{
      origin_kind: "lmc5_current",
      origin_id: "memory-race",
      content: "合成迁移竞态记忆。",
      type: "relationship",
      source_refs: [{ source_id: firstInput.source_id, revision: 1 }],
      created_at: "2026-01-05T08:00:00Z",
      updated_at: "2026-01-05T08:00:00Z"
    }]
  });
  await gate.started;
  const edited = await sourceEvent({
    ...firstInput,
    revision: 2,
    content: "合成来源在迁移索引期间发生修订。"
  });
  assert.equal((await ingest(env, edited)).response.status, 200);
  gate.release();
  const applied = await applying;
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.data.fts_indexed, 0);
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE source='migration:lmc5-current'").get() as any).status, "deleted");
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memory_fts").get() as any).n, 0);
});

test("pending review is CAS/idempotent and recall returns only current provenance", async (t) => {
  const { sqlite, db, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const now = "2026-10-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO memory_candidates (
       id, namespace, type, content, fact_key, confidence, importance, tags,
       source_message_ids, source, status, target_memory_id, decision_note,
       created_at, updated_at
     ) VALUES (?, ?, 'event', ?, NULL, 0.9, 0.8, '[]', ?, 'dream_add',
               'pending', NULL, NULL, ?, ?)`
  ).run(
    "candidate-001",
    OCTOBER_NAMESPACE,
    "小北答应周末带蓝伞。",
    JSON.stringify([messageId]),
    now,
    now
  );
  assert.equal(
    (sqlite.prepare(
      "SELECT state FROM october_source_refs WHERE artifact_kind = 'candidate'"
    ).get() as any).state,
    "pending"
  );

  const approveBody = { decision_id: "decision-001", decision_note: "synthetic approval" };
  const approved = await handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-001/approve",
      "synthetic-admin-key",
      approveBody
    ),
    env
  );
  const approvedBody = await responseJson(approved);
  assert.equal(approved.status, 200);
  assert.equal(approvedBody.data.applied, true);
  assert.equal(approvedBody.data.result_state, "active");
  const memoryId = approvedBody.data.result_artifact_id;
  assert.equal(
    (sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(memoryId) as any).status,
    "active"
  );

  const replay = await handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-001/approve",
      "synthetic-admin-key",
      approveBody
    ),
    env
  );
  assert.equal((await responseJson(replay)).data.duplicate, true);
  const conflict = await handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-001/discard",
      "synthetic-admin-key",
      { decision_id: "decision-002" }
    ),
    env
  );
  assert.equal(conflict.status, 409);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM october_review_decisions").get() as any).n, 1);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memories").get() as any).n, 1);

  const pendingLeak = sqlite.prepare(
    "SELECT count(*) AS n FROM october_source_refs WHERE artifact_kind = 'candidate' AND state = 'active'"
  ).get() as any;
  assert.equal(pendingLeak.n, 0);

  const recall = await handleOctoberRecall(
    request(
      "/v1/memory/recall",
      "synthetic-source-key",
      { namespace: OCTOBER_NAMESPACE, query: "周末蓝伞", k: 5, include_history: false }
    ),
    env
  );
  const recallBody = await responseJson(recall);
  assert.equal(recall.status, 200);
  assert.equal(recallBody.meta.source_contract, OCTOBER_CONTRACT_REVISION);
  assert.equal(recallBody.data.length, 1);
  assert.equal(recallBody.data[0].id, memoryId);
  assert.equal(recallBody.data[0].provenance[0].source_id, firstInput.source_id);
  assert.equal(recallBody.data[0].provenance[0].revision, 1);

  const edited = await sourceEvent({
    ...firstInput,
    revision: 2,
    content: "合成故事更正：小北答应周末带一把绿伞。"
  });
  assert.equal((await ingest(env, edited)).response.status, 200);
  const currentMessageId = (sqlite.prepare(
    "SELECT message_id FROM october_source_ledger WHERE source_id = ?"
  ).get(firstInput.source_id) as any).message_id;
  assert.notEqual(currentMessageId, messageId);
  assert.throws(
    () => sqlite.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, type, content, confidence, importance, tags,
         source_message_ids, source, status, created_at, updated_at
       ) VALUES ('late-old-dream', ?, 'note', 'old model output', 0.8, 0.8,
                 '[]', ?, 'dream_add', 'pending', ?, ?)`
    ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), now, now),
    /october_candidate_source_not_current/
  );
  assert.equal(
    (sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(memoryId) as any).status,
    "deleted"
  );
  assert.equal((await currentArtifactProvenance(db as any, "memory", [memoryId])).size, 0);
  const afterEdit = await handleOctoberRecall(
    request("/v1/memory/recall", "synthetic-source-key", { query: "周末蓝伞", k: 5 }),
    env
  );
  assert.deepEqual((await responseJson(afterEdit)).data, []);
});

test("delete tombstone blocks late artifacts and target-gone approval cannot fall back", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = "2026-10-14T00:00:00.000Z";

  sqlite.prepare(
    `INSERT INTO memory_candidates (
       id, namespace, type, content, fact_key, confidence, importance, tags,
       source_message_ids, source, status, target_memory_id, decision_note,
       created_at, updated_at
     ) VALUES ('candidate-target-gone', ?, 'fact', 'synthetic', NULL, 0.8, 0.8,
               '[]', ?, 'dream_update', 'pending', 'missing-memory', NULL, ?, ?)`
  ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp, stamp);
  const targetGone = await handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-target-gone/approve",
      "synthetic-admin-key",
      { decision_id: "decision-target-gone" }
    ),
    env
  );
  assert.equal(targetGone.status, 409);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memories").get() as any).n, 0);

  const deleted = await sourceEvent({
    ...firstInput,
    revision: 2,
    operation: "delete",
    content: null
  });
  const tombstone = await ingest(env, deleted);
  assert.equal(tombstone.response.status, 200);
  assert.equal(tombstone.body.data.state, "tombstoned");
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n, 0);
  assert.equal(
    (sqlite.prepare("SELECT state FROM october_source_ledger").get() as any).state,
    "tombstoned"
  );

  assert.throws(
    () =>
      sqlite.prepare(
        `INSERT INTO memories (
           id, namespace, type, content, importance, confidence, status, pinned,
           tags, source, source_message_ids, vector_id, created_at, updated_at,
           fact_key, version_status
         ) VALUES ('late-memory', ?, 'fact', 'late', 0.8, 0.8, 'active', 0,
                   '[]', 'late', ?, 'mem_late', ?, ?, NULL, 'current')`
      ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp, stamp),
    /october_memory_source_not_current/
  );
  const staleReplay = await ingest(env, first);
  assert.equal(staleReplay.response.status, 409);
  assert.equal(staleReplay.body.error.code, "stale_revision");
});

test("daily, weekly, and monthly derivatives share the same current-source gate", async (t) => {
  const { sqlite, db, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = "2026-10-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO daily_log (namespace, date, title, summary, updated_at, source_message_ids)
     VALUES (?, '2026-01-02', '合成日记', '蓝伞', ?, ?)`
  ).run(OCTOBER_NAMESPACE, stamp, JSON.stringify([messageId]));
  sqlite.prepare(
    `INSERT INTO weekly_log (
       namespace, week, start_date, end_date, title, summary, source_days, updated_at
     ) VALUES (?, '2026-W01', '2025-12-29', '2026-01-04', '合成周记', '蓝伞', 1, ?)`
  ).run(OCTOBER_NAMESPACE, stamp);
  sqlite.prepare(
    `INSERT INTO monthly_log (
       namespace, month, title, summary, source_week_count, created_at, updated_at
     ) VALUES (?, '2025-12', '合成月记', '蓝伞', 1, ?, ?)`
  ).run(OCTOBER_NAMESPACE, stamp, stamp);

  assert.equal((await currentArtifactProvenance(db as any, "daily", ["2026-01-02"])).size, 1);
  assert.equal((await currentArtifactProvenance(db as any, "weekly", ["2026-W01"])).size, 1);
  assert.equal((await currentArtifactProvenance(db as any, "monthly", ["2025-12"])).size, 1);

  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "更正为绿伞。" });
  assert.equal((await ingest(env, edited)).response.status, 200);
  assert.equal((await currentArtifactProvenance(db as any, "daily", ["2026-01-02"])).size, 0);
  assert.equal((await currentArtifactProvenance(db as any, "weekly", ["2026-W01"])).size, 0);
  assert.equal((await currentArtifactProvenance(db as any, "monthly", ["2025-12"])).size, 0);
});

test("isolated worker allowlist rejects generic active-memory writes", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const response = await worker.fetch(
    request(
      "/v1/memory",
      "synthetic-admin-key",
      { content: "must not bypass review", source_message_ids: [] }
    ),
    env,
    { waitUntil() {} } as any
  );
  assert.equal(response.status, 404);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memories").get() as any).n, 0);
});

test("boot, diary, and derived lists omit every stale source-backed layer", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  env.DREAM_TIME_ZONE = "UTC";
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  sqlite.prepare(
    `INSERT INTO daily_log (namespace, date, title, summary, updated_at, source_message_ids)
     VALUES (?, ?, '合成日记', '蓝伞', ?, ?)`
  ).run(OCTOBER_NAMESPACE, yesterday, stamp, JSON.stringify([messageId]));
  sqlite.prepare(
    `INSERT INTO precious (
       id, namespace, content, context_message_ids, source, pinned, created_at
     ) VALUES ('precious-001', ?, '合成珍贵记录', ?, 'human', 1, ?)`
  ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp);
  sqlite.prepare(
    `INSERT INTO glossary (
       id, namespace, term, aliases, definition, examples, status, updated_at,
       seen_count, source_message_ids
     ) VALUES ('glossary-001', ?, '蓝伞', '[]', '合成词条', '[]', 'active', ?, 0, ?)`
  ).run(OCTOBER_NAMESPACE, stamp, JSON.stringify([messageId]));
  sqlite.prepare(
    `INSERT INTO longtail (id, namespace, content, ts, source_message_ids)
     VALUES ('longtail-001', ?, '合成长尾', ?, ?)`
  ).run(OCTOBER_NAMESPACE, stamp, JSON.stringify([messageId]));

  const boot = await handleOctoberBoot(
    new Request("https://october.invalid/v1/memory_boot", {
      headers: { authorization: "Bearer synthetic-source-key" }
    }),
    env
  );
  const bootBody = await responseJson(boot);
  assert.equal(boot.status, 200);
  assert.equal(bootBody.data.impressions.daily.label, yesterday);
  assert.equal(bootBody.data.precious.length, 1);
  assert.equal(bootBody.data.glossary.length, 1);
  assert.deepEqual(bootBody.data.spontaneous, []);

  const diary = await handleOctoberDiary(
    new Request(`https://october.invalid/v1/diary?date=${yesterday}`, {
      headers: { authorization: "Bearer synthetic-source-key" }
    }),
    env
  );
  assert.equal((await responseJson(diary)).data.date, yesterday);
  const longtail = await handleOctoberDerivedList(
    new Request("https://october.invalid/v1/longtail", {
      headers: { authorization: "Bearer synthetic-source-key" }
    }),
    env,
    "longtail"
  );
  assert.equal((await responseJson(longtail)).data.length, 1);

  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "更正为绿伞。" });
  assert.equal((await ingest(env, edited)).response.status, 200);
  const staleBoot = await handleOctoberBoot(
    new Request("https://october.invalid/v1/memory_boot", {
      headers: { authorization: "Bearer synthetic-source-key" }
    }),
    env
  );
  const staleBootBody = await responseJson(staleBoot);
  assert.equal(staleBootBody.data.impressions.daily, null);
  assert.deepEqual(staleBootBody.data.precious, []);
  assert.deepEqual(staleBootBody.data.glossary, []);
  const staleDiary = await handleOctoberDiary(
    new Request(`https://october.invalid/v1/diary?date=${yesterday}`, {
      headers: { authorization: "Bearer synthetic-source-key" }
    }),
    env
  );
  assert.equal(staleDiary.status, 404);
});

test("failed vector cleanup stays pending until bounded admin reconciliation succeeds", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const deletedIds: string[][] = [];
  let failCleanup = true;
  env.VECTORIZE = {
    async deleteByIds(ids: string[]) {
      deletedIds.push(ids);
      if (failCleanup) throw new Error("synthetic cleanup failure");
    }
  };
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = "2026-10-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO memories (
       id, namespace, type, content, importance, confidence, status, pinned,
       tags, source, source_message_ids, vector_id, created_at, updated_at,
       fact_key, version_status
     ) VALUES ('memory-cleanup', ?, 'fact', 'synthetic', 0.8, 0.8, 'active', 0,
               '[]', 'review', ?, 'mem_memory-cleanup', ?, ?, NULL, 'current')`
  ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp, stamp);
  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "更正内容。" });
  const ack = await ingest(env, edited);
  assert.equal(ack.body.data.cleanup_state, "pending");
  assert.equal(
    (sqlite.prepare("SELECT cleanup_state FROM october_source_ledger").get() as any).cleanup_state,
    "pending"
  );
  assert.equal(deletedIds.length, 1);

  failCleanup = false;
  const reconciled = await handleOctoberReconcile(
    request("/v1/october/reconcile", "synthetic-admin-key", { limit: 10 }),
    env
  );
  const reconciledBody = await responseJson(reconciled);
  assert.deepEqual(
    {
      scanned: reconciledBody.data.scanned,
      completed: reconciledBody.data.completed,
      pending: reconciledBody.data.pending
    },
    { scanned: 1, completed: 1, pending: 0 }
  );
  assert.equal(
    (sqlite.prepare("SELECT cleanup_state FROM october_source_ledger").get() as any).cleanup_state,
    "complete"
  );
});

test("a source edit racing an approved embedding removes the late vector", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = "2026-10-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO memory_candidates (
       id, namespace, type, content, confidence, importance, tags,
       source_message_ids, source, status, created_at, updated_at
     ) VALUES ('candidate-vector-race', ?, 'note', 'synthetic race', 0.8, 0.8,
               '[]', ?, 'dream_add', 'pending', ?, ?)`
  ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp, stamp);

  let releaseEmbedding!: (value: unknown) => void;
  let embeddingStarted!: () => void;
  const started = new Promise<void>((resolve) => { embeddingStarted = resolve; });
  const embedding = new Promise<unknown>((resolve) => { releaseEmbedding = resolve; });
  const liveVectors = new Set<string>();
  const deletedIds: string[][] = [];
  env.AI = {
    async run() {
      embeddingStarted();
      return embedding;
    }
  };
  env.VECTORIZE = {
    async upsert(rows: Array<{ id: string }>) {
      for (const row of rows) liveVectors.add(row.id);
    },
    async deleteByIds(ids: string[]) {
      deletedIds.push(ids);
      for (const id of ids) liveVectors.delete(id);
    }
  };

  const review = handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-vector-race/approve",
      "synthetic-admin-key",
      { decision_id: "decision-vector-race" }
    ),
    env
  );
  await started;

  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "race revision two" });
  assert.equal((await ingest(env, edited)).response.status, 200);
  releaseEmbedding({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  assert.equal((await review).status, 200);

  const memory = sqlite.prepare("SELECT id, vector_id, status FROM memories").get() as any;
  assert.equal(memory.status, "deleted");
  assert.equal(liveVectors.has(memory.vector_id), false);
  assert.equal(deletedIds.flat().filter((id) => id === memory.vector_id).length, 2);
});

test("a source edit racing raw-message FTS removes the late stale row", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const pause = pauseNextFtsInsert(env, "message_fts");
  const first = await sourceEvent(firstInput);
  const firstWrite = ingest(env, first);
  await pause.started;

  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "late FTS revision two" });
  assert.equal((await ingest(env, edited)).response.status, 200);
  pause.release();
  assert.equal((await firstWrite).response.status, 200);

  const currentMessageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const rows = sqlite.prepare("SELECT message_id FROM message_fts ORDER BY message_id").all() as any[];
  assert.deepEqual(rows.map((row) => row.message_id), [currentMessageId]);
});

test("a source edit racing approved-memory FTS removes the late stale row", async (t) => {
  const { sqlite, env } = setup();
  t.after(() => sqlite.close());
  const first = await sourceEvent(firstInput);
  assert.equal((await ingest(env, first)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const stamp = "2026-10-14T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO memory_candidates (
       id, namespace, type, content, confidence, importance, tags,
       source_message_ids, source, status, created_at, updated_at
     ) VALUES ('candidate-fts-race', ?, 'note', 'synthetic FTS race', 0.8, 0.8,
               '[]', ?, 'dream_add', 'pending', ?, ?)`
  ).run(OCTOBER_NAMESPACE, JSON.stringify([messageId]), stamp, stamp);
  const pause = pauseNextFtsInsert(env, "memory_fts");
  const review = handleOctoberCandidateReview(
    request(
      "/v1/october/candidates/candidate-fts-race/approve",
      "synthetic-admin-key",
      { decision_id: "decision-fts-race" }
    ),
    env
  );
  await pause.started;

  const edited = await sourceEvent({ ...firstInput, revision: 2, content: "memory FTS revision two" });
  assert.equal((await ingest(env, edited)).response.status, 200);
  pause.release();
  assert.equal((await review).status, 200);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM memory_fts").get() as any).n, 0);
});

test("an early-morning Beijing message lands on its own day in the Dream range", async () => {
  const { env } = setup();
  const early = await sourceEvent({
    source_id: "synthetic/early-morning",
    conversation_id: "xh:synthetic-thread",
    speaker: "participant:user",
    role: "user",
    event_time: "2026-01-02T00:30:00+08:00",
    revision: 1,
    operation: "upsert",
    content: "synthetic early-morning message"
  });
  assert.equal((await ingest(env, early)).response.status, 200);
  const { getDateRangeForLabel } = await import("../src/memory/dreamDates");
  const { listMessagesByNamespaceInRange } = await import("../src/db/messages");
  const inDay = (label: string) => {
    const range = getDateRangeForLabel(label, "Asia/Singapore");
    return listMessagesByNamespaceInRange(env.DB, {
      namespace: OCTOBER_NAMESPACE, startCreatedAt: range.startIso, endCreatedAt: range.endIso, limit: 10
    });
  };
  assert.equal((await inDay("2026-01-02")).length, 1);
  assert.equal((await inDay("2026-01-01")).length, 0);
});

test("migration 0018 moves offset-stamped October rows onto UTC and leaves other rows alone", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql") && name < "0018").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.prepare(
    "INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("m1", "xh:t", "xu-heng", "user", "x", "shiyue-authoritative-chat", "2026-10-15T00:30:00+08:00", 0);
  sqlite.prepare(
    "INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("m2", "other", "default", "user", "y", "gateway", "2026-10-15T00:30:00+08:00", 0);
  sqlite.exec(readFileSync("migrations/0018_october_message_time_utc.sql", "utf8"));
  const rows = sqlite.prepare("SELECT id, created_at FROM messages ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((row) => row.created_at), ["2026-10-14T16:30:00.000Z", "2026-10-15T00:30:00+08:00"]);
});

test("Dream transcripts name Gu Chen apart from her and from Xu Heng", async () => {
  const { env } = setup();
  Object.assign(env, { OCTOBER_XH_USER_NAME: "她", OCTOBER_XH_ASSISTANT_NAME: "他", OCTOBER_XH_GU_CHEN_NAME: "第三人" });
  const rows: EventInput[] = [
    { source_id: "synthetic/room-1", conversation_id: "xh:room", speaker: "participant:user", role: "user",
      event_time: "2026-01-02T10:00:00+08:00", revision: 1, operation: "upsert", content: "合成：她说今天下雨" },
    { source_id: "synthetic/room-2", conversation_id: "xh:room", speaker: "participant:gu-chen", role: "user",
      event_time: "2026-01-02T10:00:05+08:00", revision: 1, operation: "upsert", content: "合成：第三人说带伞" },
    { source_id: "synthetic/room-3", conversation_id: "xh:room", speaker: "agent:xu-heng", role: "assistant",
      event_time: "2026-01-02T10:00:10+08:00", revision: 1, operation: "upsert", content: "合成：他说好" }
  ];
  for (const row of rows) assert.equal((await ingest(env, await sourceEvent(row))).response.status, 200);
  const { getDateRangeForLabel } = await import("../src/memory/dreamDates");
  const { listMessagesByNamespaceInRange } = await import("../src/db/messages");
  const { formatTranscript } = await import("../src/memory/dream/helpers");
  const { loadSpeakersForNamespace, nameOnlyRule } = await import("../src/memory/speakers");
  const range = getDateRangeForLabel("2026-01-02", "Asia/Singapore");
  const messages = await listMessagesByNamespaceInRange(env.DB, {
    namespace: OCTOBER_NAMESPACE, startCreatedAt: range.startIso, endCreatedAt: range.endIso, limit: 10
  });
  const speakers = await loadSpeakersForNamespace(env, OCTOBER_NAMESPACE);
  const transcript = formatTranscript(messages, speakers);
  assert.match(transcript, /\[她\] 合成：她说今天下雨/);
  assert.match(transcript, /\[第三人\] 合成：第三人说带伞/);
  assert.match(transcript, /\[他\] 合成：他说好/);
  assert.match(nameOnlyRule(speakers!), /标为「第三人」的话是他说的/);
});

test("Xu Heng's judge is careful with changes and boundaries and leaves people's cards alone", async () => {
  const { octoberApproveMin, listOctoberCandidatesToJudge, runCandidateJudge } = await import("../src/memory/candidateJudge");
  assert.equal(octoberApproveMin("add", "event", 0.8), 0.8);
  assert.equal(octoberApproveMin("add", "boundary", 0.8), 0.9);
  assert.equal(octoberApproveMin("update", "event", 0.8), 0.9);
  assert.equal(octoberApproveMin("delete", "fact", 0.95), 0.95);

  const { sqlite, env } = setup();
  const source = await sourceEvent({ ...firstInput, source_id: "synthetic/judge-source" });
  assert.equal((await ingest(env, source)).response.status, 200);
  const messageId = (sqlite.prepare("SELECT message_id FROM october_source_ledger").get() as any).message_id;
  const insert = sqlite.prepare(`INSERT INTO memory_candidates (id, namespace, type, content, confidence, importance, tags,
      source_message_ids, source, status, decision_note, created_at, updated_at)
    VALUES (?, 'xu-heng', 'event', ?, 0.7, 0.5, '[]', ?, ?, 'pending', ?, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')`);
  insert.run("c-dream", "合成候选一", JSON.stringify([messageId]), "dream_add", null);
  insert.run("c-judged", "合成候选二", JSON.stringify([messageId]), "dream_add", "judge: 拿不准");
  insert.run("c-migrated", "合成候选三", JSON.stringify([messageId]), "migration:lmc5-review", "migrated_from_lmc5_review");
  const due = await listOctoberCandidatesToJudge(env.DB, OCTOBER_NAMESPACE, 20);
  assert.deepEqual(due.map((row) => row.id), ["c-dream"]);

  const off = await runCandidateJudge(env, OCTOBER_NAMESPACE);
  assert.equal(off.ran, false);
  assert.equal(off.reason, "october_source_contract_requires_human_review");
});

test("the October nightly stays off until the private config turns it on", async () => {
  const { env } = setup();
  let scheduled = 0;
  await worker.scheduled({ cron: "10 20 * * *" } as any, env, { waitUntil: () => { scheduled += 1; } } as any);
  assert.equal(scheduled, 0);
});

test("Xu Heng's own memory rules reach the extract, digest and judge prompts only under the October contract", async () => {
  const { buildDreamExtractPrompt } = await import("../src/memory/dreamExtract");
  const { buildDigestPrompt } = await import("../src/memory/dream/extractPhase");
  const { buildJudgePrompt } = await import("../src/memory/candidateJudge");
  const { octoberDreamRules } = await import("../src/memory/speakers");
  const { env } = setup();
  Object.assign(env, { OCTOBER_XH_DREAM_RULES: "合成规则：引号里的话不是说话人自己的称呼" });
  const rules = octoberDreamRules(env);
  assert.equal(rules, "合成规则：引号里的话不是说话人自己的称呼");
  assert.equal(octoberDreamRules({ OCTOBER_XH_DREAM_RULES: "x" } as any), "");
  assert.match(buildDreamExtractPrompt([], [], null, rules), /这个人自己的记忆规则[\s\S]*合成规则/);
  assert.doesNotMatch(buildDreamExtractPrompt([], [], null), /这个人自己的记忆规则/);
  assert.match(buildDigestPrompt({ dateLabel: "2026-01-02", startIso: "a", endIso: "b", messages: [], existingMemories: [],
    hasMore: false, rules }), /合成规则/);
  const candidate = { id: "c", source: "dream_add", type: "event", content: "x", fact_key: null, tags: "[]",
    confidence: 0.5, importance: 0.5, source_message_ids: "[]", target_memory_id: null } as any;
  assert.match(buildJudgePrompt(candidate, [], null, rules), /合成规则/);
});

test("the vector catch-up route is admin-only and bounded", async () => {
  const { env } = setup();
  const call = (key: string, body: unknown) => worker.fetch(request("/v1/october/vectors", key, body), env, { waitUntil() {} } as any);
  assert.equal((await call("synthetic-source-key", { limit: 5 })).status, 401);
  const response = await call("synthetic-admin-key", { limit: 500, dry_run: true });
  assert.equal(response.status, 200);
  const body = await responseJson(response);
  assert.equal(body.data.namespace, OCTOBER_NAMESPACE);
  assert.equal(body.data.dry_run, true);
  assert.equal(body.data.active_memories, 0);
});
