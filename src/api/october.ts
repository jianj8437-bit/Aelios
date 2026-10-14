import { buildBootPackage, runRecall } from "../memory/v2/recall";
import {
  getDailyLog,
  getMonthlyLog,
  getWeeklyLog,
  listGlossary,
  listLongtail,
  listPrecious
} from "../db/v2";
import { getYesterdayDateLabel } from "../memory/dreamDates";
import { formatDateLabel } from "../utils/time";
import type { Env } from "../types";
import { json } from "../utils/json";
import {
  authenticateOctober,
  isOctoberContractEnabled,
  normalizeOctoberSourceEvent,
  OCTOBER_CONTRACT_REVISION,
  OCTOBER_MAX_RECALL_CHARS,
  OCTOBER_MAX_RECALL_ITEMS,
  OCTOBER_NAMESPACE,
  OctoberContractError
} from "../october/contract";
import {
  applyOctoberSourceEvent,
  currentArtifactProvenance,
  reconcileOctoberCleanup,
  reviewOctoberCandidate
} from "../october/store";
import {
  applyOctoberMigrationBatch,
  getOctoberMigrationBatch,
  rollbackOctoberMigrationBatch
} from "../october/migration";

function contractError(error: unknown): Response {
  if (error instanceof OctoberContractError) {
    return json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  console.error("october source contract request failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  return json(
    { error: { code: "source_contract_error", message: "source contract operation failed" } },
    { status: 503 }
  );
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new OctoberContractError("invalid_json", "request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OctoberContractError("invalid_json", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireEnabled(env: Env): void {
  if (!isOctoberContractEnabled(env)) {
    throw new OctoberContractError(
      "source_contract_disabled",
      "October Xu Heng source contract is not enabled",
      503
    );
  }
}

async function requireSourceAuth(request: Request, env: Env): Promise<void> {
  if (!(await authenticateOctober(request, env.OCTOBER_XH_SOURCE_API_KEY))) {
    throw new OctoberContractError("authentication_error", "Unauthorized", 401);
  }
}

async function requireAdminAuth(request: Request, env: Env): Promise<void> {
  if (!(await authenticateOctober(request, env.OCTOBER_XH_ADMIN_API_KEY))) {
    throw new OctoberContractError("authentication_error", "Unauthorized", 401);
  }
}

export async function handleOctoberSourceEvent(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "POST") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireSourceAuth(request, env);
    const event = await normalizeOctoberSourceEvent(await readObject(request));
    const ack = await applyOctoberSourceEvent(env, event);
    return json({ data: ack });
  } catch (error) {
    return contractError(error);
  }
}

function readRecallLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 5;
  if (!Number.isFinite(parsed)) return OCTOBER_MAX_RECALL_ITEMS;
  return Math.min(Math.max(Math.floor(parsed), 1), OCTOBER_MAX_RECALL_ITEMS);
}

export async function handleOctoberRecall(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "POST") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireSourceAuth(request, env);
    const body = await readObject(request);
    if (body.namespace !== undefined && body.namespace !== OCTOBER_NAMESPACE) {
      throw new OctoberContractError("namespace_denied", "namespace is fixed to xu-heng", 403);
    }
    if (body.include_history === true) {
      throw new OctoberContractError("history_denied", "include_history must remain false", 400);
    }
    if (typeof body.query !== "string" || !body.query.trim()) {
      throw new OctoberContractError("invalid_recall", "query is required", 400);
    }

    const strictEnv: Env = {
      ...env,
      RECALL_REQUIRE_D1_BACKING: "true"
    };
    const result = await runRecall(strictEnv, {
      namespace: OCTOBER_NAMESPACE,
      query: body.query.trim(),
      k: readRecallLimit(body.k ?? body.top_k),
      min_score:
        typeof body.min_score === "number" && Number.isFinite(body.min_score)
          ? body.min_score
          : undefined,
      types: Array.isArray(body.types)
        ? body.types.filter((item): item is string => typeof item === "string")
        : [],
      include_history: false
    });

    const memoryIds = result.hits.filter((hit) => hit.kind === "memory").map((hit) => hit.id);
    const longtailIds = result.hits.filter((hit) => hit.kind === "longtail").map((hit) => hit.id);
    const glossaryIds = result.glossary_hits.map((hit) => hit.id);
    const weekIds = result.week_blocks.map((block) => block.week);
    const [memorySources, longtailSources, glossarySources, weekSources] = await Promise.all([
      currentArtifactProvenance(env.DB, "memory", memoryIds),
      currentArtifactProvenance(env.DB, "longtail", longtailIds),
      currentArtifactProvenance(env.DB, "glossary", glossaryIds),
      currentArtifactProvenance(env.DB, "weekly", weekIds)
    ]);

    let chars = 0;
    const data = [];
    for (const hit of result.hits) {
      const provenance = (hit.kind === "memory" ? memorySources : longtailSources).get(hit.id);
      if (!provenance || provenance.length === 0) continue;
      if (data.length >= OCTOBER_MAX_RECALL_ITEMS) break;
      if (hit.content.length > OCTOBER_MAX_RECALL_CHARS || chars + hit.content.length > OCTOBER_MAX_RECALL_CHARS) {
        continue;
      }
      chars += hit.content.length;
      data.push({
        id: hit.id,
        content: hit.content,
        type: hit.type,
        score: hit.score,
        source_layer: hit.source_layer,
        provenance
      });
    }

    const glossaryHits = result.glossary_hits
      .filter((hit) => glossarySources.has(hit.id))
      .map((hit) => ({ ...hit, provenance: glossarySources.get(hit.id) }));
    const weekBlocks = result.week_blocks
      .filter((block) => weekSources.has(block.week))
      .map((block) => ({ ...block, provenance: weekSources.get(block.week) }));

    return json({
      data,
      glossary_hits: glossaryHits,
      week_blocks: weekBlocks,
      meta: {
        namespace: OCTOBER_NAMESPACE,
        source_contract: OCTOBER_CONTRACT_REVISION,
        backend: "v2-recall-source-backed",
        top_k: readRecallLimit(body.k ?? body.top_k),
        count: data.length,
        chars,
        source_filtered: result.hits.length - data.length,
        glossary_hits: glossaryHits.length,
        week_block_count: weekBlocks.length
      }
    });
  } catch (error) {
    return contractError(error);
  }
}

export async function handleOctoberBoot(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "GET") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireSourceAuth(request, env);
    const pkg = await buildBootPackage(env, { namespace: OCTOBER_NAMESPACE });
    const dailyId = pkg.impressions.daily?.label;
    const weeklyId = pkg.impressions.weekly?.label;
    const monthlyId = pkg.impressions.monthly?.label;
    const [dailySources, weeklySources, monthlySources, preciousSources, glossarySources] =
      await Promise.all([
        currentArtifactProvenance(env.DB, "daily", dailyId ? [dailyId] : []),
        currentArtifactProvenance(env.DB, "weekly", weeklyId ? [weeklyId] : []),
        currentArtifactProvenance(env.DB, "monthly", monthlyId ? [monthlyId] : []),
        currentArtifactProvenance(env.DB, "precious", pkg.precious.map((row) => row.id)),
        currentArtifactProvenance(env.DB, "glossary", pkg.glossary.map((row) => row.id))
      ]);

    const daily = dailyId && dailySources.has(dailyId)
      ? { ...pkg.impressions.daily, provenance: dailySources.get(dailyId) }
      : null;
    const weekly = weeklyId && weeklySources.has(weeklyId)
      ? { ...pkg.impressions.weekly, provenance: weeklySources.get(weeklyId) }
      : null;
    const monthly = monthlyId && monthlySources.has(monthlyId)
      ? { ...pkg.impressions.monthly, provenance: monthlySources.get(monthlyId) }
      : null;
    const precious = pkg.precious
      .filter((row) => preciousSources.has(row.id))
      .map((row) => ({ ...row, provenance: preciousSources.get(row.id) }));
    const glossary = pkg.glossary
      .filter((row) => glossarySources.has(row.id))
      .map((row) => ({ ...row, provenance: glossarySources.get(row.id) }));

    return json({
      data: {
        namespace: OCTOBER_NAMESPACE,
        impressions: {
          daily,
          weekly,
          monthly,
          max_chars: pkg.impressions.max_chars
        },
        precious,
        glossary,
        // perception_cache in stable v2.0.0 has no raw source IDs. It is
        // deliberately omitted instead of being treated as evidence.
        spontaneous: [],
        schema_version: pkg.schema_version,
        cache_prefix_end: true
      },
      meta: {
        namespace: OCTOBER_NAMESPACE,
        source_contract: OCTOBER_CONTRACT_REVISION
      }
    });
  } catch (error) {
    return contractError(error);
  }
}

export async function handleOctoberDiary(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "GET") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireSourceAuth(request, env);
    const url = new URL(request.url);
    const rows: Array<{ kind: "daily" | "weekly" | "monthly"; id: string; value: unknown }> = [];
    const date = url.searchParams.get("date")?.trim();
    const week = url.searchParams.get("week")?.trim();
    const month = url.searchParams.get("month")?.trim();
    if (url.pathname.endsWith("/recent")) {
      const timeZone = env.DREAM_TIME_ZONE?.trim() || "Asia/Singapore";
      const today = formatDateLabel(new Date(), timeZone);
      const yesterday = getYesterdayDateLabel(timeZone);
      for (const label of [today, yesterday]) {
        const row = await getDailyLog(env.DB, { namespace: OCTOBER_NAMESPACE, date: label });
        if (row) rows.push({ kind: "daily", id: label, value: row });
      }
    } else if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const row = await getDailyLog(env.DB, { namespace: OCTOBER_NAMESPACE, date });
      if (row) rows.push({ kind: "daily", id: date, value: row });
    } else if (week && /^\d{4}-W\d{2}$/.test(week)) {
      const row = await getWeeklyLog(env.DB, { namespace: OCTOBER_NAMESPACE, week });
      if (row) rows.push({ kind: "weekly", id: week, value: row });
    } else if (month && /^\d{4}-\d{2}$/.test(month)) {
      const row = await getMonthlyLog(env.DB, { namespace: OCTOBER_NAMESPACE, month });
      if (row) rows.push({ kind: "monthly", id: month, value: row });
    } else {
      throw new OctoberContractError(
        "invalid_diary_query",
        "date, week, or month is required",
        400
      );
    }

    const data = [];
    for (const row of rows) {
      const sources = await currentArtifactProvenance(env.DB, row.kind, [row.id]);
      const provenance = sources.get(row.id);
      if (provenance) data.push({ ...(row.value as object), provenance });
    }
    return json({
      data: url.pathname.endsWith("/recent") ? data : data[0] ?? null,
      meta: {
        namespace: OCTOBER_NAMESPACE,
        source_contract: OCTOBER_CONTRACT_REVISION
      }
    }, data.length > 0 || url.pathname.endsWith("/recent") ? {} : { status: 404 });
  } catch (error) {
    return contractError(error);
  }
}

function readListLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? 100);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 200) : 100;
}

export async function handleOctoberDerivedList(
  request: Request,
  env: Env,
  kind: "precious" | "glossary" | "longtail"
): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "GET") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireSourceAuth(request, env);
    const url = new URL(request.url);
    const rows = kind === "precious"
      ? await listPrecious(env.DB, { namespace: OCTOBER_NAMESPACE, limit: readListLimit(url) })
      : kind === "glossary"
        ? await listGlossary(env.DB, { namespace: OCTOBER_NAMESPACE, status: "active" })
        : await listLongtail(env.DB, { namespace: OCTOBER_NAMESPACE, limit: readListLimit(url) });
    const sources = await currentArtifactProvenance(env.DB, kind, rows.map((row) => row.id));
    const data = rows
      .filter((row) => sources.has(row.id))
      .map((row) => ({ ...row, provenance: sources.get(row.id) }));
    return json({
      data,
      meta: {
        namespace: OCTOBER_NAMESPACE,
        source_contract: OCTOBER_CONTRACT_REVISION,
        count: data.length
      }
    });
  } catch (error) {
    return contractError(error);
  }
}

function readDecisionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value)) {
    throw new OctoberContractError("invalid_decision", "decision_id is required and has an invalid format");
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function handleOctoberCandidateReview(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "POST") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireAdminAuth(request, env);
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const candidateId = parts[3];
    const action = parts[4];
    if (!candidateId || (action !== "approve" && action !== "discard")) {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    const body = await readObject(request);
    if (Object.hasOwn(body, "source_message_ids")) {
      throw new OctoberContractError(
        "source_override_denied",
        "candidate source_message_ids cannot be overridden",
        400
      );
    }
    const result = await reviewOctoberCandidate(env, {
      decisionId: readDecisionId(body.decision_id),
      candidateId,
      action,
      content: typeof body.content === "string" && body.content.trim() ? body.content.trim() : undefined,
      type: typeof body.type === "string" && body.type.trim() ? body.type.trim() : undefined,
      factKey:
        body.fact_key === null
          ? null
          : typeof body.fact_key === "string" && body.fact_key.trim()
            ? body.fact_key.trim()
            : undefined,
      confidence: optionalFiniteNumber(body.confidence),
      importance: optionalFiniteNumber(body.importance),
      tags: Array.isArray(body.tags)
        ? body.tags.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : undefined,
      decisionNote:
        typeof body.decision_note === "string" && body.decision_note.trim()
          ? body.decision_note.trim()
          : undefined
    });
    return json({ data: result });
  } catch (error) {
    return contractError(error);
  }
}

export async function handleOctoberReconcile(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    if (request.method !== "POST") {
      throw new OctoberContractError("not_found", "Not found", 404);
    }
    await requireAdminAuth(request, env);
    const body = await readObject(request);
    const limit = optionalFiniteNumber(body.limit) ?? 25;
    return json({ data: await reconcileOctoberCleanup(env, limit) });
  } catch (error) {
    return contractError(error);
  }
}

export async function handleOctoberMigration(request: Request, env: Env): Promise<Response> {
  try {
    requireEnabled(env);
    await requireAdminAuth(request, env);
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const batchId = parts[3];
    const action = parts[4];
    if (request.method === "POST" && !batchId) {
      return json({ data: await applyOctoberMigrationBatch(env, await readObject(request)) });
    }
    if (request.method === "GET" && batchId && !action) {
      return json({ data: await getOctoberMigrationBatch(env, batchId) });
    }
    if (request.method === "POST" && batchId && action === "rollback") {
      return json({ data: await rollbackOctoberMigrationBatch(env, batchId) });
    }
    throw new OctoberContractError("not_found", "Not found", 404);
  } catch (error) {
    return contractError(error);
  }
}
