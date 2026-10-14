import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OCTOBER_XH_RESOURCES = Object.freeze({
  worker: "october-xh-aelios",
  d1: "october-xh-aelios-db",
  vectorize: "october-xh-aelios-vector",
  queue: "october-xh-aelios-queue",
  queueDlq: "october-xh-aelios-dlq"
});

export const OCTOBER_XH_CONTRACT = "october-xh-source-v1";
export const OCTOBER_XH_QUEUE_MAX_RETRIES = 3;
/** Xu Heng's nightly Dream: 20:10 UTC = 04:10 Asia/Singapore, after his day is over. */
export const OCTOBER_XH_NIGHTLY_CRON = "10 20 * * *";

/**
 * What only the private deployment decides: the names his transcripts use, and whether the nightly Dream and
 * the candidate judge run. All default to off/absent, which keeps the isolated release exactly as before.
 */
export interface OctoberXhDreamSettings {
  names?: { user: string; assistant: string; guChen: string };
  nightly?: boolean;
  judge?: boolean;
}

function checkedName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 32 || /["\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`dream names.${field} must be 1-32 plain characters`);
  }
  return value.trim();
}

const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_CODE_URL = /^https:\/\/github\.com\/jianj8437-bit\/Aelios\/tree\/[0-9a-f]{40}$/;

function countLine(source: string, pattern: RegExp) {
  return source.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

function replaceExactLine(source: string, pattern: RegExp, replacement: string, expected = 1) {
  const count = countLine(source, pattern);
  if (count !== expected) {
    throw new Error(`expected ${expected} config line(s) matching ${pattern}, found ${count}`);
  }
  return source.replace(new RegExp(pattern.source, "gm"), replacement);
}

function removeTopLevelTable(source: string, table: string) {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  let found = 0;
  for (const line of lines) {
    if (line.trim() === `[${table}]`) {
      skipping = true;
      found += 1;
      continue;
    }
    if (skipping && line.trimStart().startsWith("[")) skipping = false;
    if (!skipping) output.push(line);
  }
  if (found !== 1) throw new Error(`expected one [${table}] table, found ${found}`);
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function upsertVar(source: string, name: string, value: string) {
  const pattern = new RegExp(`^${name}\\s*=.*$`);
  const count = countLine(source, pattern);
  if (count > 1) throw new Error(`duplicate [vars] entry: ${name}`);
  if (count === 1) return source.replace(new RegExp(pattern.source, "m"), `${name} = "${value}"`);
  if (!source.includes("[vars]\n")) throw new Error("wrangler config has no [vars] table");
  return source.replace("[vars]\n", `[vars]\n${name} = "${value}"\n`);
}

function assertRenderedConfig(
  source: string,
  d1Id: string,
  entrypoint: string,
  migrationsDir: string,
  sourceCodeUrl: string,
  dream: OctoberXhDreamSettings = {}
) {
  const requiredLines = [
    `main = "${entrypoint}"`,
    `name = "${OCTOBER_XH_RESOURCES.worker}"`,
    "workers_dev = true",
    "preview_urls = false",
    `index_name = "${OCTOBER_XH_RESOURCES.vectorize}"`,
    `database_name = "${OCTOBER_XH_RESOURCES.d1}"`,
    `database_id = "${d1Id}"`,
    `migrations_dir = "${migrationsDir}"`,
    `max_retries = ${OCTOBER_XH_QUEUE_MAX_RETRIES}`,
    `dead_letter_queue = "${OCTOBER_XH_RESOURCES.queueDlq}"`,
    `VECTORIZE_INDEX_NAME = "${OCTOBER_XH_RESOURCES.vectorize}"`,
    `OCTOBER_XH_SOURCE_CONTRACT = "${OCTOBER_XH_CONTRACT}"`,
    `OCTOBER_XH_SOURCE_CODE_URL = "${sourceCodeUrl}"`,
    'MEMORY_LIFECYCLE_ENABLED = "true"',
    'RECALL_REQUIRE_D1_BACKING = "true"',
    'CANDIDATE_JUDGE_ENABLED = "false"'
  ];
  for (const line of requiredLines) {
    if (source.split("\n").filter((candidate) => candidate === line).length !== 1) {
      throw new Error(`rendered config is missing or duplicates: ${line}`);
    }
  }
  if (dream.nightly) {
    if (countLine(source, /^\[triggers\]$/) !== 1 || source.split("\n").filter((line) => line === `crons = ["${OCTOBER_XH_NIGHTLY_CRON}"]`).length !== 1 ||
        countLine(source, /^crons\s*=/) !== 1 || countLine(source, /^OCTOBER_XH_NIGHTLY = "on"$/) !== 1) {
      throw new Error("the nightly config must carry exactly the Xu Heng nightly cron and its switch");
    }
  } else if (source.includes("[triggers]") || /^crons\s*=/m.test(source) || /^OCTOBER_XH_NIGHTLY\s*=/m.test(source)) {
    throw new Error("October Xu Heng config must not enable cron triggers");
  }
  if (source.includes('name = "companion-memory-proxy"') ||
      source.includes('index_name = "memo-kb"') ||
      source.includes('queue = "companion-memory"') ||
      source.includes('database_name = "companion_memory_proxy"')) {
    throw new Error("rendered config still references an upstream default resource");
  }
  if (countLine(source, new RegExp(`^queue = "${OCTOBER_XH_RESOURCES.queue}"$`)) !== 2) {
    throw new Error("producer and consumer must both use the isolated October Xu Heng queue");
  }
  if (/^OCTOBER_XH_(?:SOURCE|ADMIN)_API_KEY\s*=/m.test(source)) {
    throw new Error("secrets must never be rendered into wrangler config");
  }
}

export function renderOctoberXhConfig(
  source: string,
  d1Id: string,
  sourceCodeUrl: string,
  entrypoint = "src/index.ts",
  migrationsDir = "migrations",
  dream: OctoberXhDreamSettings = {}
) {
  if (!D1_ID.test(d1Id)) throw new Error("--d1-id must be a Cloudflare D1 UUID");
  if (!SOURCE_CODE_URL.test(sourceCodeUrl)) {
    throw new Error("--source-code-url must pin the public October fork to an exact 40-character commit");
  }
  if (entrypoint !== "src/index.ts" && !isAbsolute(entrypoint)) {
    throw new Error("external config entrypoint must be absolute");
  }
  if (migrationsDir !== "migrations" && !isAbsolute(migrationsDir)) {
    throw new Error("external config migrations_dir must be absolute");
  }
  let rendered = source.replace(/\r\n/g, "\n");
  rendered = replaceExactLine(rendered, /^main = "src\/index\.ts"$/, `main = "${entrypoint}"`);
  rendered = replaceExactLine(rendered, /^name = "companion-memory-proxy"$/, `name = "${OCTOBER_XH_RESOURCES.worker}"`);
  for (const setting of ["workers_dev", "preview_urls"]) {
    if (countLine(rendered, new RegExp(`^${setting}\\s*=`)) !== 0) {
      throw new Error(`upstream config already defines or duplicates: ${setting}`);
    }
  }
  rendered = rendered.replace(
    `name = "${OCTOBER_XH_RESOURCES.worker}"`,
    `name = "${OCTOBER_XH_RESOURCES.worker}"\nworkers_dev = true\npreview_urls = false`
  );
  rendered = removeTopLevelTable(rendered, "triggers");
  rendered = replaceExactLine(rendered, /^VECTORIZE_INDEX_NAME = "memo-kb"$/, `VECTORIZE_INDEX_NAME = "${OCTOBER_XH_RESOURCES.vectorize}"`);
  rendered = replaceExactLine(rendered, /^index_name = "memo-kb"$/, `index_name = "${OCTOBER_XH_RESOURCES.vectorize}"`);
  rendered = replaceExactLine(rendered, /^queue = "companion-memory"$/, `queue = "${OCTOBER_XH_RESOURCES.queue}"`, 2);
  if (countLine(rendered, /^migrations_dir\s*=/) !== 0) {
    throw new Error("upstream config already defines or duplicates: migrations_dir");
  }
  for (const setting of ["max_retries", "dead_letter_queue"]) {
    if (countLine(rendered, new RegExp(`^${setting}\\s*=`)) !== 0) {
      throw new Error(`upstream config already defines or duplicates: ${setting}`);
    }
  }
  const consumerQueue = `[[queues.consumers]]\nqueue = "${OCTOBER_XH_RESOURCES.queue}"`;
  if (rendered.split(consumerQueue).length !== 2) {
    throw new Error("expected one isolated October Xu Heng queue consumer");
  }
  rendered = rendered.replace(
    consumerQueue,
    `${consumerQueue}\nmax_retries = ${OCTOBER_XH_QUEUE_MAX_RETRIES}\ndead_letter_queue = "${OCTOBER_XH_RESOURCES.queueDlq}"`
  );
  rendered = replaceExactLine(rendered, /^database_name = "companion_memory_proxy"$/, `database_name = "${OCTOBER_XH_RESOURCES.d1}"`);
  rendered = rendered.replace(
    `database_name = "${OCTOBER_XH_RESOURCES.d1}"`,
    `database_name = "${OCTOBER_XH_RESOURCES.d1}"\ndatabase_id = "${d1Id}"\nmigrations_dir = "${migrationsDir}"`
  );
  rendered = upsertVar(rendered, "OCTOBER_XH_SOURCE_CONTRACT", OCTOBER_XH_CONTRACT);
  rendered = upsertVar(rendered, "OCTOBER_XH_SOURCE_CODE_URL", sourceCodeUrl);
  rendered = upsertVar(rendered, "MEMORY_LIFECYCLE_ENABLED", "true");
  rendered = upsertVar(rendered, "RECALL_REQUIRE_D1_BACKING", "true");
  rendered = upsertVar(rendered, "CANDIDATE_JUDGE_ENABLED", "false");
  if (dream.names) {
    rendered = upsertVar(rendered, "OCTOBER_XH_USER_NAME", checkedName(dream.names.user, "user"));
    rendered = upsertVar(rendered, "OCTOBER_XH_ASSISTANT_NAME", checkedName(dream.names.assistant, "assistant"));
    rendered = upsertVar(rendered, "OCTOBER_XH_GU_CHEN_NAME", checkedName(dream.names.guChen, "guChen"));
  }
  if (dream.judge) rendered = upsertVar(rendered, "OCTOBER_XH_JUDGE", "on");
  if (dream.nightly) {
    if (!dream.names) throw new Error("the nightly Dream needs names, or Gu Chen's words would read as hers");
    rendered = upsertVar(rendered, "OCTOBER_XH_NIGHTLY", "on");
    rendered = `${rendered.trimEnd()}\n\n[triggers]\ncrons = ["${OCTOBER_XH_NIGHTLY_CRON}"]\n`;
  }
  rendered = `${rendered.trimEnd()}\n`;
  assertRenderedConfig(rendered, d1Id, entrypoint, migrationsDir, sourceCodeUrl, dream);
  return rendered;
}

export function writeOctoberXhConfig(
  sourcePath: string,
  outputPath: string,
  d1Id: string,
  sourceCodeUrl: string,
  repositoryRoot: string,
  dream: OctoberXhDreamSettings = {}
) {
  if (!isAbsolute(outputPath)) throw new Error("--out must be an absolute path outside the repository");
  const resolvedRoot = resolve(repositoryRoot);
  const resolvedOutput = resolve(outputPath);
  const withinRepository = relative(resolvedRoot, resolvedOutput);
  if (withinRepository === "" || (!withinRepository.startsWith("..") && !isAbsolute(withinRepository))) {
    throw new Error("refusing to write an account-specific D1 id inside the repository");
  }
  const rendered = renderOctoberXhConfig(
    readFileSync(sourcePath, "utf8"),
    d1Id,
    sourceCodeUrl,
    resolve(resolvedRoot, "src/index.ts"),
    resolve(resolvedRoot, "migrations"),
    dream
  );
  writeFileSync(resolvedOutput, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(resolvedOutput, 0o600);
  return {
    output: resolvedOutput,
    sha256: createHash("sha256").update(rendered).digest("hex"),
    resources: OCTOBER_XH_RESOURCES,
    cron: dream.nightly ? OCTOBER_XH_NIGHTLY_CRON : "disabled",
    judge: dream.judge ? "on" : "off",
    secretsRendered: false
  };
}

function optionalOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1]) throw new Error(`missing value for ${name}`);
  return args[index + 1];
}

/** The private settings file: {"names": {...}, "nightly": bool, "judge": bool}; absolute path, owner-only. */
function readDreamSettings(path: string | null): OctoberXhDreamSettings {
  if (!path) return {};
  if (!isAbsolute(path)) throw new Error("--dream must be an absolute path");
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("--dream file must be readable by its owner only");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const names = raw.names as Record<string, unknown> | undefined;
  return {
    names: names ? { user: String(names.user ?? ""), assistant: String(names.assistant ?? ""), guChen: String(names.guChen ?? "") } : undefined,
    nightly: raw.nightly === true,
    judge: raw.judge === true
  };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const result = writeOctoberXhConfig(
      resolve(root, "wrangler.toml"),
      option(process.argv.slice(2), "--out"),
      option(process.argv.slice(2), "--d1-id"),
      option(process.argv.slice(2), "--source-code-url"),
      root,
      readDreamSettings(optionalOption(process.argv.slice(2), "--dream"))
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
