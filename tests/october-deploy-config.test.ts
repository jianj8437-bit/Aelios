import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  OCTOBER_XH_CONTRACT,
  OCTOBER_XH_QUEUE_MAX_RETRIES,
  OCTOBER_XH_RESOURCES,
  renderOctoberXhConfig,
  writeOctoberXhConfig
} from "../scripts/render-october-xh-config";

const D1_ID = "11111111-2222-4333-8444-555555555555";
const root = resolve(import.meta.dirname, "..");
const upstream = readFileSync(resolve(root, "wrangler.toml"), "utf8");

test("renders isolated October Xu Heng bindings with cron disabled", () => {
  const rendered = renderOctoberXhConfig(upstream, D1_ID);
  assert.match(rendered, new RegExp(`^name = "${OCTOBER_XH_RESOURCES.worker}"$`, "m"));
  assert.match(rendered, new RegExp(`^database_name = "${OCTOBER_XH_RESOURCES.d1}"$`, "m"));
  assert.match(rendered, new RegExp(`^database_id = "${D1_ID}"$`, "m"));
  assert.match(rendered, new RegExp(`^index_name = "${OCTOBER_XH_RESOURCES.vectorize}"$`, "m"));
  assert.equal(rendered.match(new RegExp(`^queue = "${OCTOBER_XH_RESOURCES.queue}"$`, "gm"))?.length, 2);
  assert.match(rendered, new RegExp(`^OCTOBER_XH_SOURCE_CONTRACT = "${OCTOBER_XH_CONTRACT}"$`, "m"));
  assert.match(rendered, /^MEMORY_LIFECYCLE_ENABLED = "true"$/m);
  assert.match(rendered, /^RECALL_REQUIRE_D1_BACKING = "true"$/m);
  assert.match(rendered, /^CANDIDATE_JUDGE_ENABLED = "false"$/m);
  assert.doesNotMatch(rendered, /^\[triggers\]$/m);
  assert.doesNotMatch(rendered, /^crons\s*=/m);
  assert.doesNotMatch(rendered, /^OCTOBER_XH_(?:SOURCE|ADMIN)_API_KEY\s*=/m);
  assert.doesNotMatch(rendered, /name = "companion-memory-proxy"|index_name = "memo-kb"|queue = "companion-memory"|database_name = "companion_memory_proxy"/);
});

test("renders bounded queue retries with an isolated dead-letter queue", () => {
  const rendered = renderOctoberXhConfig(upstream, D1_ID);
  assert.match(rendered, new RegExp(`^max_retries = ${OCTOBER_XH_QUEUE_MAX_RETRIES}$`, "m"));
  assert.match(rendered, new RegExp(`^dead_letter_queue = "${OCTOBER_XH_RESOURCES.queueDlq}"$`, "m"));
  assert.equal(rendered.match(/^max_retries\s*=/gm)?.length, 1);
  assert.equal(rendered.match(/^dead_letter_queue\s*=/gm)?.length, 1);
});

test("fails closed on invalid resource identity or upstream config drift", () => {
  assert.throws(() => renderOctoberXhConfig(upstream, "not-a-d1-id"), /D1 UUID/);
  assert.throws(
    () => renderOctoberXhConfig(upstream.replace('queue = "companion-memory"', 'queue = "renamed-upstream"'), D1_ID),
    /expected 2 config line/
  );
  assert.throws(
    () => renderOctoberXhConfig(upstream.replace("[triggers]", "[scheduled]"), D1_ID),
    /expected one \[triggers\]/
  );
  assert.throws(
    () => renderOctoberXhConfig(upstream.replace("max_batch_size = 10", "max_retries = 7\nmax_batch_size = 10"), D1_ID),
    /duplicates: max_retries/
  );
});

test("writes mode 0600 outside the repository and never overwrites", () => {
  const temp = mkdtempSync(join(tmpdir(), "october-xh-config-"));
  const output = join(temp, "wrangler.october-xh.toml");
  try {
    const result = writeOctoberXhConfig(resolve(root, "wrangler.toml"), output, D1_ID, root);
    assert.equal(result.output, output);
    assert.equal(result.cron, "disabled");
    assert.equal(result.secretsRendered, false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.match(readFileSync(output, "utf8"), new RegExp(`^main = "${resolve(root, "src/index.ts")}"$`, "m"));
    assert.match(readFileSync(output, "utf8"), new RegExp(`^migrations_dir = "${resolve(root, "migrations")}"$`, "m"));
    assert.throws(() => writeOctoberXhConfig(resolve(root, "wrangler.toml"), output, D1_ID, root), /EEXIST/);
    assert.throws(
      () => writeOctoberXhConfig(resolve(root, "wrangler.toml"), resolve(root, "wrangler.october-xh.toml"), D1_ID, root),
      /inside the repository/
    );
    assert.throws(
      () => renderOctoberXhConfig(upstream.replace('main = "src/index.ts"', 'main = "src/renamed.ts"'), D1_ID),
      /expected 1 config line/
    );
    assert.throws(
      () => renderOctoberXhConfig(upstream.replace("max_batch_size = 10", 'migrations_dir = "elsewhere"\nmax_batch_size = 10'), D1_ID),
      /duplicates: migrations_dir/
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
