import type { Env } from "../types";
import { json } from "../utils/json";
import { OCTOBER_CONTRACT_REVISION } from "./contract";

const SOURCE_LICENSE = "AGPL-3.0-only";

function sourceCodeUrl(env: Env): string | null {
  const value = env.OCTOBER_XH_SOURCE_CODE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function handleOctoberSourceOffer(env: Env): Response {
  const url = sourceCodeUrl(env);
  if (!url) {
    return json(
      { error: { code: "source_offer_unavailable", message: "Corresponding Source URL is not configured" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  return json(
    {
      license: SOURCE_LICENSE,
      contract_revision: OCTOBER_CONTRACT_REVISION,
      source_code_url: url
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        Link: `<${url}>; rel="source"`
      }
    }
  );
}

export function withOctoberSourceOffer(response: Response, env: Env): Response {
  const url = sourceCodeUrl(env);
  if (!url) return response;
  const headers = new Headers(response.headers);
  headers.set("Link", `<${url}>; rel="source"`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
