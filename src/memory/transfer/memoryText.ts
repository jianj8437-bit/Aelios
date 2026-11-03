import { CANONICAL_MEMORY_TYPES, type CanonicalMemoryType } from "../canonicalTypes";

// 记忆的文字格式：导出成人能看、能直接改的 md (和字段齐全的 jsonl)，以及把这两种、
// 别家导出的 json、手写的 md 或纯文本解析回一条条记忆。
//
// md 一行一条：
//   - 2026-09-21 咲咲答题要先给答案，再讲选项。 #学习 #答题 `preference:answer-style`
// 开头是日期 (可省)，接着可以有 [类型]，然后正文；末尾 # 开头的是标签，反引号里的是 fact_key。
// 二级标题决定类型 (「## 偏好 preference」下面的都是偏好)；「## 珍贵」下面的是珍贵原文。
// 正文换行时续行缩进两格。正文里本来就有的 # 和反引号写成 \# 和 \`，免得被当成标签和 key。

export type TransferKind = "memory" | "precious";

export interface ImportEntry {
  kind: TransferKind;
  content: string;
  /** 8 个固定类型之一；没写就是 null，导入时按 fact 处理。 */
  type: CanonicalMemoryType | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** jsonl 里带的完整时间 */
  createdAt: string | null;
  tags: string[];
  factKey: string | null;
  importance: number | null;
  confidence: number | null;
  pinned: boolean;
}

export type ImportTextFormat = "aelios-jsonl" | "jsonl" | "json" | "markdown";

export interface ParsedImport {
  format: ImportTextFormat;
  entries: ImportEntry[];
  /** 认不出来、跳过的行或条目数 */
  skipped: number;
  warnings: string[];
}

export interface ExportMemoryRow {
  id: string;
  type: string;
  content: string;
  fact_key: string | null;
  tags: string[];
  importance: number;
  confidence: number;
  pinned: boolean;
  source: string | null;
  source_message_ids: string[];
  created_at: string;
  updated_at: string;
  valid_as_of: string | null;
  authored_by: string | null;
  response_tendency: string | null;
}

export interface ExportPreciousRow {
  id: string;
  content: string;
  source: string | null;
  created_at: string;
}

export const MEMORY_TYPE_LABELS: Record<CanonicalMemoryType, string> = {
  fact: "事实",
  event: "事件",
  preference: "偏好",
  relationship: "关系",
  boundary: "边界",
  habit: "习惯",
  decision: "决定",
  note: "笔记"
};

export const MAX_IMPORT_ENTRIES = 5000;
export const MAX_ENTRY_CHARS = 4000;

// 标题、[类型] 里出现这些词就归到对应类型。先查珍贵，再查英文名，最后中文词。
const TYPE_WORDS: Array<[CanonicalMemoryType, string[]]> = [
  ["relationship", ["关系", "感情", "恋爱", "人际", "我们俩", "我们"]],
  ["boundary", ["边界", "雷区", "禁忌", "底线", "红线", "不要做"]],
  ["preference", ["偏好", "喜好", "喜欢", "口味", "爱好"]],
  ["habit", ["习惯", "作息", "日常"]],
  ["decision", ["决定", "承诺", "约定", "计划"]],
  ["event", ["事件", "经历", "大事", "回忆", "发生"]],
  ["fact", ["事实", "基本信息", "个人信息", "信息", "资料", "背景", "身份"]],
  ["note", ["笔记", "备注", "其他", "其它", "杂项", "补充"]]
];
const PRECIOUS_WORDS = ["珍贵", "珍藏", "precious"];

export function mapTypeName(name: string | null | undefined): CanonicalMemoryType | null {
  const text = (name ?? "").trim().toLowerCase();
  if (!text) return null;
  for (const type of CANONICAL_MEMORY_TYPES) {
    if (text === type || new RegExp(`(^|[^a-z_])${type}([^a-z_]|$)`).test(text)) return type;
  }
  for (const [type, words] of TYPE_WORDS) {
    if (words.some((word) => text.includes(word))) return type;
  }
  return null;
}

function isPreciousName(name: string): boolean {
  const text = name.trim().toLowerCase();
  return PRECIOUS_WORDS.some((word) => text.includes(word));
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function escapeContent(content: string): string {
  // 词首的 # 和所有反引号转义；多个空行并成一个换行 (md 里空行会把条目断开)；续行缩进两格。
  const escaped = content
    .trim()
    .replace(/`/g, "\\`")
    .replace(/(^|\s)#/g, "$1\\#")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/\n/g, "\n  ");
  // 正文开头像日期、像 [类型]、或是破折号冒号这些分隔符，导回去会被当成条目头吃掉：前面垫一个 \。
  return /^[[【\\|｜:：,，、—–-]/.test(escaped) || DATE_HEAD_RE.test(escaped) ? `\\${escaped}` : escaped;
}

function formatTag(tag: string): string | null {
  const clean = tag.trim().replace(/\s+/g, "_").replace(/[#`]/g, "");
  return clean ? `#${clean}` : null;
}

function dateLabelIn(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function timeLabelIn(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${dateLabelIn(iso, timeZone)} ${values.get("hour")}:${values.get("minute")}`;
}

function formatEntryLine(input: { date: string | null; content: string; tags?: string[]; factKey?: string | null }): string {
  const pieces = [input.date, escapeContent(input.content)].filter(Boolean) as string[];
  for (const tag of input.tags ?? []) {
    const formatted = formatTag(tag);
    if (formatted) pieces.push(formatted);
  }
  if (input.factKey && !/[\s`]/.test(input.factKey)) pieces.push(`\`${input.factKey}\``);
  return `- ${pieces.join(" ")}`;
}

function typeOrder(type: string): number {
  const index = (CANONICAL_MEMORY_TYPES as readonly string[]).indexOf(type);
  return index === -1 ? CANONICAL_MEMORY_TYPES.length : index;
}

export function formatMemoriesMarkdown(input: {
  namespace: string;
  title?: string | null;
  exportedAt: string;
  timeZone: string;
  memories: ExportMemoryRow[];
  precious: ExportPreciousRow[];
}): string {
  const heading = input.title ? `${input.title}（${input.namespace}）` : input.namespace;
  const lines = [
    `# Aelios 记忆：${heading}`,
    "",
    `> 导出于 ${timeLabelIn(input.exportedAt, input.timeZone)}（${input.timeZone}），记忆 ${input.memories.length} 条，珍贵 ${input.precious.length} 条。`,
    ">",
    "> 这份文件可以直接改，改完在 Aelios 后台「更多 → 导入导出」导回去。",
    "> 一行一条：开头是日期，接着是正文；# 开头的是标签，最后反引号里是这条记忆的 key。",
    "> key 认的是「同一件事」：导回去时 key 一样的会改写原来那条，不会多出一条重复的。新加的条目不用写 key。",
    "> 二级标题是类型，条目写在哪个标题下面就是哪一类。正文里本来就有的 # 和反引号前面加了 \\。",
    "> 导回去只会新增和改写，不会删掉库里已有的记忆。"
  ];

  const groups = new Map<string, ExportMemoryRow[]>();
  for (const memory of input.memories) {
    const list = groups.get(memory.type) ?? [];
    list.push(memory);
    groups.set(memory.type, list);
  }
  const types = [...groups.keys()].sort((a, b) => typeOrder(a) - typeOrder(b) || a.localeCompare(b));
  for (const type of types) {
    const label = MEMORY_TYPE_LABELS[type as CanonicalMemoryType];
    lines.push("", `## ${label ? `${label} ${type}` : type}`, "");
    const rows = [...(groups.get(type) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const memory of rows) {
      lines.push(
        formatEntryLine({
          date: dateLabelIn(memory.created_at, input.timeZone),
          content: memory.content,
          tags: memory.tags,
          factKey: memory.fact_key
        })
      );
    }
  }

  if (input.precious.length > 0) {
    lines.push("", "## 珍贵 precious", "");
    const rows = [...input.precious].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const item of rows) {
      lines.push(formatEntryLine({ date: dateLabelIn(item.created_at, input.timeZone), content: item.content }));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatMemoriesJsonl(input: {
  namespace: string;
  exportedAt: string;
  memories: ExportMemoryRow[];
  precious: ExportPreciousRow[];
}): string {
  const lines = [
    JSON.stringify({
      kind: "aelios_export",
      version: 1,
      namespace: input.namespace,
      exported_at: input.exportedAt,
      memories: input.memories.length,
      precious: input.precious.length
    }),
    ...input.memories.map((memory) => JSON.stringify({ kind: "memory", ...memory })),
    ...input.precious.map((item) => JSON.stringify({ kind: "precious", ...item }))
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 导入：解析
// ---------------------------------------------------------------------------

const DATE_HEAD_RE =
  /^[[（(【]?\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*(?:\d{1,2}:\d{2}(?::\d{2})?))?\s*[\]）)】]?/;

function normalizeDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clampUnit(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null;
  return Math.min(Math.max(numeric, 0), 1);
}

function cleanFactKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key && key.length <= 200 && !/[\s`]/.test(key) ? key : null;
}

function cleanTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return [...new Set(raw.map((tag) => tag.trim().replace(/^#/, "")).filter((tag) => tag && tag.length <= 40))].slice(0, 20);
}

/** 解析一条 md / 纯文本条目：日期、[类型]、正文、末尾的 #标签 和 `key`。 */
export function parseEntryText(text: string): {
  content: string;
  date: string | null;
  type: CanonicalMemoryType | null;
  tags: string[];
  factKey: string | null;
} {
  let rest = text.trim();
  let date: string | null = null;
  let type: CanonicalMemoryType | null = null;

  const dateMatch = rest.match(DATE_HEAD_RE);
  if (dateMatch) {
    const normalized = normalizeDate(dateMatch[1], dateMatch[2], dateMatch[3]);
    if (normalized) {
      date = normalized;
      rest = rest.slice(dateMatch[0].length).replace(/^[\s|｜:：,，、—–-]+/, "");
    }
  }

  const typeMatch = rest.match(/^[[【]([^\]】\n]{1,16})[\]】]\s*/);
  if (typeMatch) {
    const mapped = mapTypeName(typeMatch[1]);
    if (mapped) {
      type = mapped;
      rest = rest.slice(typeMatch[0].length).replace(/^[\s|｜:：,，、—–-]+/, "");
    }
  }
  // 导出时垫在正文前面的 \：后面的字原样是正文。
  if (rest.startsWith("\\")) rest = rest.slice(1);

  // 末尾的 #标签 和 `key`，顺序随意。前面带 \ 的是正文里转义过的，不算。
  const tags: string[] = [];
  let factKey: string | null = null;
  for (;;) {
    const keyMatch = rest.match(/(^|\s)`([^`\s]+)`\s*$/);
    if (keyMatch && !factKey) {
      const before = rest.slice(0, rest.length - keyMatch[0].length);
      if (!before.endsWith("\\")) {
        factKey = cleanFactKey(keyMatch[2]);
        rest = before.trimEnd();
        continue;
      }
    }
    const tagMatch = rest.match(/(^|\s)#([^\s#`\\]+)\s*$/);
    if (tagMatch) {
      tags.unshift(tagMatch[2]);
      rest = rest.slice(0, rest.length - tagMatch[0].length).trimEnd();
      continue;
    }
    break;
  }

  const content = rest
    .replace(/\\#/g, "#")
    .replace(/\\`/g, "`")
    .trim();
  return { content, date, type, tags: cleanTags(tags), factKey };
}

const LIST_ITEM_RE = /^(?:[-*+•·]|\d{1,4}[.)、])\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/;
// AI 写的清单常拿一整行粗体或「偏好：」当小标题。
const PSEUDO_HEADING_RE = /^(?:\*\*|__)(.{1,30}?)(?:\*\*|__)\s*[:：]?$|^([^\s:：]{1,12})[:：]$/;

function parseMarkdown(text: string): ParsedImport {
  const entries: ImportEntry[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let sectionType: CanonicalMemoryType | null = null;
  let sectionKind: TransferKind = "memory";
  let inFence = false;
  let current: string[] | null = null;
  let tables = 0;

  const flush = () => {
    if (!current) return;
    const parsed = parseEntryText(current.join("\n"));
    current = null;
    if (!parsed.content) {
      skipped += 1;
      return;
    }
    if (Array.from(parsed.content).length > MAX_ENTRY_CHARS) {
      skipped += 1;
      warnings.push(`有一条超过 ${MAX_ENTRY_CHARS} 字，跳过了：「${Array.from(parsed.content).slice(0, 30).join("")}…」`);
      return;
    }
    entries.push({
      kind: sectionKind,
      content: parsed.content,
      type: parsed.type ?? sectionType,
      date: parsed.date,
      createdAt: null,
      tags: parsed.tags,
      factKey: sectionKind === "memory" ? parsed.factKey : null,
      importance: null,
      confidence: null,
      pinned: false
    });
  };

  const setSection = (title: string) => {
    if (isPreciousName(title)) {
      sectionKind = "precious";
      sectionType = null;
      return;
    }
    sectionKind = "memory";
    sectionType = mapTypeName(title);
  };

  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!rawLine.trim()) {
      flush();
      continue;
    }
    if (current && /^(\s{2,}|\t)\S/.test(rawLine)) {
      (current as string[]).push(rawLine.trim());
      continue;
    }
    const line = rawLine.trim();
    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      setSection(heading[1]);
      continue;
    }
    if (/^>/.test(line) || /^<!--/.test(line) || /^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(line)) {
      flush();
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      tables += 1;
      continue;
    }
    const pseudo = line.match(PSEUDO_HEADING_RE);
    if (pseudo) {
      flush();
      setSection(pseudo[1] ?? pseudo[2] ?? "");
      continue;
    }
    const item = line.match(LIST_ITEM_RE);
    flush();
    current = [item ? item[1] : line];
  }
  flush();
  if (tables > 0) {
    skipped += tables;
    warnings.push(`有 ${tables} 行表格没有导入，表格请改成一行一条。`);
  }
  return { format: "markdown", entries, skipped, warnings };
}

function readObjectString(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function entryFromObject(value: unknown): ImportEntry | "header" | null {
  if (typeof value === "string") {
    const parsed = parseEntryText(value);
    if (!parsed.content) return null;
    return {
      kind: "memory",
      content: parsed.content,
      type: parsed.type,
      date: parsed.date,
      createdAt: null,
      tags: parsed.tags,
      factKey: parsed.factKey,
      importance: null,
      confidence: null,
      pinned: false
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object.kind === "aelios_export") return "header";
  const metadata =
    object.metadata && typeof object.metadata === "object" && !Array.isArray(object.metadata)
      ? (object.metadata as Record<string, unknown>)
      : {};
  const content = readObjectString(object, ["content", "text", "memory", "value", "fact", "description", "summary"]);
  if (!content) return null;
  const createdRaw =
    readObjectString(object, ["created_at", "createdAt", "date", "timestamp", "time"]) ??
    readObjectString(metadata, ["created_at", "createdAt", "date"]);
  let createdAt: string | null = null;
  let date: string | null = null;
  if (createdRaw) {
    const head = createdRaw.match(DATE_HEAD_RE);
    date = head ? normalizeDate(head[1], head[2], head[3]) : null;
    if (date && !Number.isNaN(Date.parse(createdRaw)) && /T\d{2}:\d{2}/.test(createdRaw)) {
      createdAt = new Date(createdRaw).toISOString();
    }
  }
  const kind: TransferKind = object.kind === "precious" ? "precious" : "memory";
  const typeName = readObjectString(object, ["type", "category"]) ?? readObjectString(metadata, ["type", "category"]);
  return {
    kind,
    content: content.trim(),
    type: kind === "memory" ? mapTypeName(typeName) : null,
    date,
    createdAt,
    tags: cleanTags(object.tags ?? metadata.tags),
    factKey: kind === "memory" ? cleanFactKey(object.fact_key ?? object.key ?? metadata.fact_key) : null,
    importance: clampUnit(object.importance ?? metadata.importance),
    confidence: clampUnit(object.confidence ?? metadata.confidence),
    pinned: object.pinned === true || object.pinned === 1 || metadata.pinned === true
  };
}

function collectJsonItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["data", "memories", "items", "entries"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
    return [value];
  }
  return [];
}

function parseJsonItems(items: unknown[], format: ImportTextFormat): ParsedImport {
  const entries: ImportEntry[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let sawHeader = false;
  for (const item of items) {
    const entry = entryFromObject(item);
    if (entry === "header") {
      sawHeader = true;
      continue;
    }
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (Array.from(entry.content).length > MAX_ENTRY_CHARS) {
      skipped += 1;
      warnings.push(`有一条超过 ${MAX_ENTRY_CHARS} 字，跳过了：「${Array.from(entry.content).slice(0, 30).join("")}…」`);
      continue;
    }
    entries.push(entry);
  }
  return { format: sawHeader && format === "jsonl" ? "aelios-jsonl" : format, entries, skipped, warnings };
}

/** 认格式：整段是 JSON → json；每行都是 JSON → jsonl；其余当 md / 纯文本。 */
export function parseMemoryImport(text: string): ParsedImport {
  const source = text.replace(/^﻿/, "").trim();
  let result: ParsedImport;
  if (/^[[{]/.test(source)) {
    let whole: unknown;
    let wholeOk = false;
    try {
      whole = JSON.parse(source);
      wholeOk = true;
    } catch {
      wholeOk = false;
    }
    if (wholeOk) {
      result = parseJsonItems(collectJsonItems(whole), "json");
    } else {
      const lines = source.split(/\r?\n/).filter((line) => line.trim());
      const items: unknown[] = [];
      let bad = 0;
      for (const line of lines) {
        try {
          items.push(JSON.parse(line));
        } catch {
          bad += 1;
        }
      }
      if (items.length > 0 && bad <= Math.max(1, lines.length * 0.1)) {
        result = parseJsonItems(items, "jsonl");
        result.skipped += bad;
        if (bad > 0) result.warnings.push(`有 ${bad} 行不是完整的 JSON，跳过了。`);
      } else {
        result = parseMarkdown(source);
      }
    }
  } else {
    result = parseMarkdown(source);
  }

  if (result.entries.length > MAX_IMPORT_ENTRIES) {
    result.warnings.push(`一次最多导入 ${MAX_IMPORT_ENTRIES} 条，后面 ${result.entries.length - MAX_IMPORT_ENTRIES} 条请分开导。`);
    result.skipped += result.entries.length - MAX_IMPORT_ENTRIES;
    result.entries = result.entries.slice(0, MAX_IMPORT_ENTRIES);
  }
  return result;
}

/** 给用户贴给原来那个 AI 的话：让它按上面的格式把记得的事列出来。 */
export function buildImportPrompt(userName?: string | null): string {
  const name = userName?.trim() || "";
  const subject = name ? `称呼我时写「${name}」` : "称呼我时写我的名字";
  const example = name || "阿树";
  return [
    "请把你记得的关于我的事全部列出来，我要搬到别的记忆库里。按下面的格式，一行一条，除了清单别写别的话：",
    "",
    "- 日期 [类型] 内容 #标签",
    "",
    "日期写 YYYY-MM-DD，是你知道这件事的那天；不知道就省掉。",
    "类型从这几个里挑一个：事实、事件、偏好、关系、边界、习惯、决定、笔记。",
    `内容写成一句完整的话，${subject}，不要用「你」「我」，免得搬过去分不清是谁。`,
    "每条只讲一件事，原话里要紧的词用「」保留。标签可以没有，最多三个。",
    "",
    "例如：",
    `- 2025-12-15 [关系] ${example}第一次在聊天里叫对方老公。 #纪念日`,
    `- [偏好] ${example}喝咖啡要跟饭隔一个小时。 #健康`
  ].join("\n");
}
