import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";

export const OCTOBER_CONTRACT_REVISION = "october-xh-source-v1";
export const OCTOBER_NAMESPACE = "xu-heng";
export const OCTOBER_SOURCE = "shiyue-authoritative-chat";
export const OCTOBER_MAX_CONTENT_CHARS = 200_000;
export const OCTOBER_MAX_RECALL_ITEMS = 5;
export const OCTOBER_MAX_RECALL_CHARS = 4_800;

const SPEAKER_ROLES = {
  "participant:user": "user",
  "participant:gu-chen": "user",
  "agent:xu-heng": "assistant"
} as const;

export type OctoberRole = "user" | "assistant";
export type OctoberOperation = "upsert" | "delete";

export interface OctoberSourceEvent {
  contract_revision: typeof OCTOBER_CONTRACT_REVISION;
  namespace: typeof OCTOBER_NAMESPACE;
  source: typeof OCTOBER_SOURCE;
  source_id: string;
  conversation_id: string;
  speaker: keyof typeof SPEAKER_ROLES;
  role: OctoberRole;
  event_time: string;
  revision: number;
  operation: OctoberOperation;
  content: string | null;
  content_sha256: string | null;
  event_id: string;
  message_id: string;
}

export class OctoberContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "OctoberContractError";
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new OctoberContractError(code, message, status);
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_event", "source event must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp
): string {
  if (typeof value !== "string") fail("invalid_event", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    fail("invalid_event", `${field} must contain 1-${maxLength} characters`);
  }
  if ([...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    fail("invalid_event", `${field} contains control characters`);
  }
  if (pattern && !pattern.test(trimmed)) fail("invalid_event", `${field} has an invalid format`);
  return trimmed;
}

function readEventTime(value: unknown): string {
  const eventTime = readBoundedString(value, "event_time", 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(eventTime) ||
    !Number.isFinite(Date.parse(eventTime))
  ) {
    fail("invalid_event", "event_time must be an ISO-8601 timestamp with an explicit timezone");
  }
  return eventTime;
}

export function isOctoberContractEnabled(env: Env): boolean {
  return env.OCTOBER_XH_SOURCE_CONTRACT === OCTOBER_CONTRACT_REVISION;
}

export async function octoberMessageId(sourceId: string, revision: number): Promise<string> {
  const hash = await sha256Hex(
    `${OCTOBER_NAMESPACE}\n${OCTOBER_SOURCE}\n${sourceId}\n${revision}`
  );
  return `xhmsg_${hash.slice(0, 48)}`;
}

export async function octoberReviewMemoryId(decisionId: string): Promise<string> {
  const hash = await sha256Hex(`${OCTOBER_CONTRACT_REVISION}\nreview\n${decisionId}`);
  return `xhmem_${hash.slice(0, 48)}`;
}

export async function normalizeOctoberSourceEvent(value: unknown): Promise<OctoberSourceEvent> {
  const input = readObject(value);

  if (input.contract_revision !== OCTOBER_CONTRACT_REVISION) {
    fail("contract_revision_mismatch", `contract_revision must be ${OCTOBER_CONTRACT_REVISION}`);
  }
  if (input.namespace !== undefined && input.namespace !== OCTOBER_NAMESPACE) {
    fail("namespace_denied", `namespace is fixed to ${OCTOBER_NAMESPACE}`, 403);
  }
  if (input.source !== OCTOBER_SOURCE) {
    fail("source_denied", `source is fixed to ${OCTOBER_SOURCE}`, 403);
  }

  const operation = input.operation;
  if (operation !== "upsert" && operation !== "delete") {
    fail("invalid_event", "operation must be upsert or delete");
  }

  const sourceId = readBoundedString(input.source_id, "source_id", 200, /^[A-Za-z0-9._:/-]+$/);
  const conversationId = readBoundedString(
    input.conversation_id,
    "conversation_id",
    200,
    /^[A-Za-z0-9._:/-]+$/
  );
  if (!conversationId.startsWith("xh:")) {
    fail("conversation_denied", "conversation_id must use the xh: domain", 403);
  }

  const speaker = readBoundedString(input.speaker, "speaker", 128, /^[A-Za-z0-9._:/-]+$/);
  if (!(speaker in SPEAKER_ROLES)) {
    fail("speaker_denied", "speaker is not allowed by the Xu Heng source contract", 403);
  }
  const stableSpeaker = speaker as keyof typeof SPEAKER_ROLES;
  const role = SPEAKER_ROLES[stableSpeaker];
  if (input.role !== role) {
    fail("speaker_role_mismatch", "role does not match the stable speaker identity");
  }

  const eventTime = readEventTime(input.event_time);
  const rawRevision = input.revision;
  if (!Number.isSafeInteger(rawRevision) || (rawRevision as number) < 1) {
    fail("invalid_event", "revision must be a positive safe integer");
  }
  const revision = rawRevision as number;

  let content: string | null = null;
  let contentSha256: string | null = null;
  if (operation === "upsert") {
    if (
      typeof input.content !== "string" ||
      input.content.length === 0 ||
      input.content.length > OCTOBER_MAX_CONTENT_CHARS
    ) {
      fail("invalid_event", `upsert content must contain 1-${OCTOBER_MAX_CONTENT_CHARS} characters`);
    }
    content = input.content;
    contentSha256 = await sha256Hex(content);
    if (input.content_sha256 !== contentSha256) {
      fail("content_hash_mismatch", "content_sha256 does not match content");
    }
  } else if (input.content !== undefined && input.content !== null && input.content !== "") {
    fail("invalid_event", "delete events must not carry message content");
  } else if (input.content_sha256 !== null) {
    fail("invalid_event", "delete events must set content_sha256 to null");
  }

  const fingerprint = [
    OCTOBER_CONTRACT_REVISION,
    OCTOBER_NAMESPACE,
    OCTOBER_SOURCE,
    sourceId,
    String(revision),
    operation,
    conversationId,
    stableSpeaker,
    role,
    eventTime,
    contentSha256 ?? ""
  ].join("\n");
  const eventId = `xhsrc_${await sha256Hex(fingerprint)}`;
  if (input.event_id !== eventId) fail("event_id_mismatch", "event_id does not match the canonical event");

  return {
    contract_revision: OCTOBER_CONTRACT_REVISION,
    namespace: OCTOBER_NAMESPACE,
    source: OCTOBER_SOURCE,
    source_id: sourceId,
    conversation_id: conversationId,
    speaker: stableSpeaker,
    role,
    event_time: eventTime,
    revision,
    operation,
    content,
    content_sha256: contentSha256,
    event_id: eventId,
    message_id: await octoberMessageId(sourceId, revision)
  };
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();
  return request.headers.get("x-api-key")?.trim() || null;
}

async function equalSecret(candidate: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

export async function authenticateOctober(
  request: Request,
  expected: string | undefined
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token || !expected) return false;
  return equalSecret(token, expected);
}
