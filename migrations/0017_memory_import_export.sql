-- 记忆导入导出 + 改写留旧版
--
-- 1) memory_revisions：一条记忆被原地改写 (同 fact_key 再写、后台编辑、合并) 之前，先把旧文本存一份。
--    以前只有 supersede 那条路留旧版，原地 UPDATE 的旧文本直接没了。每条记忆最多留 20 版。
-- 2) memory_imports / memory_import_chunks：一次导入是一个批次，聊天记录按天切成一段段送来，
--    做完的段记下来，同一份文件再传一次就从断点接着做；token 用量也记在这里。
-- 3) imported_messages：导入的聊天原文，只存被候选引用到的那几句，留作出处。
--    不进 messages 表：messages 有 7 天保留期 (MESSAGES_RETENTION_DAYS)，按消息时间删，
--    旧聊天按原日期落进去会被当晚清掉；夜间整理也按日期扫 messages，会把导入的旧聊天再整理一遍。
-- 4) memory_import_candidates：导入候选的附加信息 (哪个批次、哪一天、clef 怎么看)。
--    候选本身仍在 memory_candidates，source 是 import_chat / import_entries，
--    夜里的 clef 自动审和助手的 MCP 审核都跳过它们，等本人在审核页点。

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  type TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  importance REAL,
  confidence REAL,
  source TEXT,
  source_message_ids TEXT,
  fact_key TEXT,
  written_at TEXT,          -- 这版文字当初写下的时间 (旧行的 updated_at)
  replaced_by TEXT,         -- 谁改写了它 (来源，如 dream、review、manual、import)
  reason TEXT,
  created_at TEXT NOT NULL  -- 被改写的时间
);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory
ON memory_revisions(memory_id, created_at);

CREATE TABLE IF NOT EXISTS memory_imports (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,                 -- chat | entries
  name TEXT,
  fingerprint TEXT NOT NULL,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  done_chunks INTEGER NOT NULL DEFAULT 0,
  total_messages INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL DEFAULT 0,
  first_date TEXT,
  last_date TEXT,
  candidates INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  clef_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, fingerprint)
);

CREATE TABLE IF NOT EXISTS memory_import_chunks (
  import_id TEXT NOT NULL,
  chunk_key TEXT NOT NULL,
  status TEXT NOT NULL,               -- done | error
  messages INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  clef_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (import_id, chunk_key)
);

CREATE TABLE IF NOT EXISTS imported_messages (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  import_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  speaker TEXT,
  created_at TEXT,                    -- 原聊天里的时间，没有就空着
  day TEXT,                           -- 切段时归到哪一天 (YYYY-MM-DD)，没日期的为空
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_imported_messages_import
ON imported_messages(namespace, import_id);

CREATE TABLE IF NOT EXISTS memory_import_candidates (
  candidate_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  day TEXT,
  clef_grounded REAL,
  clef_worth REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_import_candidates_import
ON memory_import_candidates(import_id);
