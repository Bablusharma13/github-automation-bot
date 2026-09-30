import "server-only";
import type { AiTriage } from "@/lib/ai-triage";
import {
  buildTriagePrompt,
  parseTriage,
  TRIAGE_INSTRUCTIONS,
  TRIAGE_RESPONSE_SCHEMA,
  TriageOutputError,
  type TriageInput,
} from "./triage";

export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Stable, free-tier model that thinks minimally by default (verified 2026-09-30). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const TIMEOUT_MS = 15_000;

/** A failed triage request. `retryable`: network, timeout, 429 (quota) and 5xx. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiError";
  }
}

type GeminiPart = { text?: unknown; thought?: unknown };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
};

export function buildGenerateContentRequest(input: TriageInput) {
  return {
    systemInstruction: { parts: [{ text: TRIAGE_INSTRUCTIONS }] },
    contents: [{ role: "user", parts: [{ text: buildTriagePrompt(input) }] }],
    generationConfig: {
      // `responseFormat` replaces the deprecated responseMimeType/responseSchema pair.
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: TRIAGE_RESPONSE_SCHEMA } },
      maxOutputTokens: 2048,
    },
  };
}

/**
 * Asks Gemini (models.generateContent, REST v1beta) for a triage suggestion. The key goes
 * in the x-goog-api-key header — never in the URL — and is scrubbed from any error text,
 * so it cannot end up in the database, the dashboard or logs.
 */
export async function generateTriage(opts: {
  apiKey: string;
  model: string;
  input: TriageInput;
}): Promise<AiTriage> {
  const scrub = (s: string) => (opts.apiKey ? s.split(opts.apiKey).join("[redacted]") : s);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_API_URL}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify(buildGenerateContentRequest(opts.input)),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new AiError("Could not reach the Gemini API (network error or timeout).", null, true, {
      cause: err,
    });
  }

  const text = await res.text().catch(() => "");
  let data: GeminiResponse = {};
  try {
    data = text ? (JSON.parse(text) as GeminiResponse) : {};
  } catch {
    data = {};
  }

  if (!res.ok) {
    const detail = scrub(String(data.error?.message ?? res.statusText ?? "")).slice(0, 200);
    const status = data.error?.status ? ` ${data.error.status}` : "";
    if (res.status === 429) {
      throw new AiError(
        `Gemini rate limit or quota reached (429${status}). Use "Retry failed steps" later.`,
        429,
        true,
      );
    }
    throw new AiError(
      `Gemini API error ${res.status}${status}${detail ? `: ${detail}` : ""}`,
      res.status,
      res.status >= 500,
    );
  }

  if (data.promptFeedback?.blockReason) {
    throw new AiError(`Gemini declined to answer (blocked: ${data.promptFeedback.blockReason}).`, 200, false);
  }
  const candidate = data.candidates?.[0];
  if (!candidate) throw new AiError("Gemini returned no answer.", 200, false);
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new AiError(`Gemini stopped before finishing (${candidate.finishReason}).`, 200, false);
  }
  // Thinking models may include thought parts; only the answer text is parsed.
  const answer = (candidate.content?.parts ?? [])
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  try {
    return parseTriage(answer);
  } catch (err) {
    if (err instanceof TriageOutputError) throw new AiError(err.message, 200, false, { cause: err });
    throw err;
  }
}
