import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function assertRenderedConfig(source: string, d1Id: string) {
  const requiredLines = [
    `name = "${OCTOBER_XH_RESOURCES.worker}"`,
    `index_name = "${OCTOBER_XH_RESOURCES.vectorize}"`,
    `database_name = "${OCTOBER_XH_RESOURCES.d1}"`,
    `database_id = "${d1Id}"`,
    `max_retries = ${OCTOBER_XH_QUEUE_MAX_RETRIES}`,
    `dead_letter_queue = "${OCTOBER_XH_RESOURCES.queueDlq}"`,
    `VECTORIZE_INDEX_NAME = "${OCTOBER_XH_RESOURCES.vectorize}"`,
    `OCTOBER_XH_SOURCE_CONTRACT = "${OCTOBER_XH_CONTRACT}"`,
    'MEMORY_LIFECYCLE_ENABLED = "true"',
    'RECALL_REQUIRE_D1_BACKING = "true"',
    'CANDIDATE_JUDGE_ENABLED = "false"'
  ];
  for (const line of requiredLines) {
    if (source.split("\n").filter((candidate) => candidate === line).length !== 1) {
      throw new Error(`rendered config is missing or duplicates: ${line}`);
    }
  }
  if (source.includes("[triggers]") || /^crons\s*=/m.test(source)) {
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

export function renderOctoberXhConfig(source: string, d1Id: string) {
  if (!D1_ID.test(d1Id)) throw new Error("--d1-id must be a Cloudflare D1 UUID");
  let rendered = source.replace(/\r\n/g, "\n");
  rendered = replaceExactLine(rendered, /^name = "companion-memory-proxy"$/, `name = "${OCTOBER_XH_RESOURCES.worker}"`);
  rendered = removeTopLevelTable(rendered, "triggers");
  rendered = replaceExactLine(rendered, /^VECTORIZE_INDEX_NAME = "memo-kb"$/, `VECTORIZE_INDEX_NAME = "${OCTOBER_XH_RESOURCES.vectorize}"`);
  rendered = replaceExactLine(rendered, /^index_name = "memo-kb"$/, `index_name = "${OCTOBER_XH_RESOURCES.vectorize}"`);
  rendered = replaceExactLine(rendered, /^queue = "companion-memory"$/, `queue = "${OCTOBER_XH_RESOURCES.queue}"`, 2);
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
    `database_name = "${OCTOBER_XH_RESOURCES.d1}"\ndatabase_id = "${d1Id}"`
  );
  rendered = upsertVar(rendered, "OCTOBER_XH_SOURCE_CONTRACT", OCTOBER_XH_CONTRACT);
  rendered = upsertVar(rendered, "MEMORY_LIFECYCLE_ENABLED", "true");
  rendered = upsertVar(rendered, "RECALL_REQUIRE_D1_BACKING", "true");
  rendered = upsertVar(rendered, "CANDIDATE_JUDGE_ENABLED", "false");
  rendered = `${rendered.trimEnd()}\n`;
  assertRenderedConfig(rendered, d1Id);
  return rendered;
}

export function writeOctoberXhConfig(sourcePath: string, outputPath: string, d1Id: string, repositoryRoot: string) {
  if (!isAbsolute(outputPath)) throw new Error("--out must be an absolute path outside the repository");
  const resolvedRoot = resolve(repositoryRoot);
  const resolvedOutput = resolve(outputPath);
  const withinRepository = relative(resolvedRoot, resolvedOutput);
  if (withinRepository === "" || (!withinRepository.startsWith("..") && !isAbsolute(withinRepository))) {
    throw new Error("refusing to write an account-specific D1 id inside the repository");
  }
  const rendered = renderOctoberXhConfig(readFileSync(sourcePath, "utf8"), d1Id);
  writeFileSync(resolvedOutput, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(resolvedOutput, 0o600);
  return {
    output: resolvedOutput,
    sha256: createHash("sha256").update(rendered).digest("hex"),
    resources: OCTOBER_XH_RESOURCES,
    cron: "disabled",
    secretsRendered: false
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
      root
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
