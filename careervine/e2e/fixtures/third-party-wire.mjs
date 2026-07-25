/**
 * Non-Google third-party **wire** payloads for the E2E tier (CAR-196).
 *
 * Sibling of `google-wire.mjs`, split by vendor so each file's name keeps
 * meaning what it says. Same rules apply: these are HTTP response *bodies*, not
 * client-object doubles, and they are plain `.mjs` because the server preload
 * that consumes them is loaded by raw Node via `--import`, before any TypeScript
 * loader exists.
 *
 * Every export here exists because CAR-191 needs the origin stubbed. Shapes were
 * read off the consuming code, not guessed:
 *   - OpenAI      → BOTH APIs. `src/lib/ai-followup/*` uses
 *                   `chat.completions.create`; the transcript routes, the
 *                   extension's profile parser and the BYOK key-save validator
 *                   use `responses.create`. Stubbing only one left the other
 *                   denied, and the OpenAI SDK retried that denial with backoff
 *                   into a 60-second test timeout — which is how the gap first
 *                   showed up. (The catch-all now answers 418, outside every
 *                   client's retry band, so a miss fails once and by name.)
 *   - Deepgram    → `src/app/api/settings/deepgram-key/route.ts` (status only)
 *                   and `transcribe/route.ts` (`listen.v1.media.transcribeUrl`)
 *   - Apify       → `src/lib/apify/client.ts` (`{ data: run }`, dataset arrays)
 *   - Resend      → `src/lib/notify/email.ts`
 *   - Serper      → `src/lib/serper.ts` (`{ news }` / `{ organic }`)
 *   - Upstash     → `@upstash/ratelimit`'s sliding-window script
 */

/**
 * Response body of `POST /v1/chat/completions`.
 *
 * The app asks for prose in some call sites and strict JSON in others
 * (`response_format: json_object`), so the content is a parameter rather than a
 * fixed string.
 *
 * Note that no SPEC can vary it today: the handlers in `register.mjs` pass a
 * fixed `"{}"`, and they run inside the Next server process, which a Playwright
 * worker has no channel into. Varying the response needs a control endpoint on
 * the stub layer, which nothing has asked for yet. The parameter is here so the
 * fixture is reusable when something does, not because it is reachable now.
 */
export function openAiChatResponse({
  content = "This is E2E stub output.",
  model = "gpt-4o-mini",
} = {}) {
  return {
    id: "chatcmpl-e2e-0001",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

/**
 * Response body of `POST /v1/responses` (the Responses API).
 *
 * Callers read `response.output_text`, which the API returns as a real field —
 * but the `output` array is populated to match, because a body with one and not
 * the other is the kind of half-shaped fixture that passes until someone reads
 * the structured output instead.
 */
export function openAiResponsesResponse({ text = "{}", model = "gpt-4o-mini" } = {}) {
  return {
    id: "resp-e2e-0001",
    object: "response",
    created_at: 1700000000,
    model,
    status: "completed",
    output_text: text,
    output: [
      {
        id: "msg-e2e-0001",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
}

/**
 * Response body of Deepgram's `POST /v1/listen`.
 *
 * `transcribe/route.ts` maps `results.utterances[]` into transcript segments, so
 * the default carries two utterances from different speakers — enough for a spec
 * to assert diarisation actually round-tripped.
 */
export function deepgramTranscribeResponse(
  utterances = [
    { speaker: 0, start: 0, end: 2.5, transcript: "Thanks for making the time today." },
    { speaker: 1, start: 2.6, end: 5.0, transcript: "Happy to. Tell me about the role." },
  ],
) {
  return {
    metadata: { request_id: "e2e-deepgram-0001", channels: 1, duration: 5 },
    results: {
      utterances,
      channels: [
        {
          alternatives: [
            { transcript: utterances.map((u) => u.transcript).join(" "), confidence: 0.99 },
          ],
        },
      ],
    },
  };
}

/**
 * Response body of Deepgram's `GET /v1/projects`.
 *
 * The BYOK key-save route only reads the *status* (200 accepts the key, 401/403
 * rejects it); the body is never parsed. It is shaped correctly anyway so a
 * future consumer is not surprised.
 */
export function deepgramProjectsResponse() {
  return {
    projects: [{ project_id: "e2e-deepgram-project", name: "E2E" }],
  };
}

/** A terminal Apify run, as `{ data }` — the envelope `client.ts` unwraps. */
export function apifyRunResponse({
  id = "e2e-apify-run-0001",
  status = "SUCCEEDED",
  defaultDatasetId = "e2e-apify-dataset-0001",
} = {}) {
  return {
    data: {
      id,
      actId: "e2e-actor",
      status,
      defaultDatasetId,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
      usageTotalUsd: 0,
    },
  };
}

/** Dataset items — a bare array, not an envelope. Empty is the safe default. */
export function apifyDatasetItemsResponse(items = []) {
  return items;
}

/** Response body of `POST https://api.resend.com/emails`. */
export function resendSendResponse({ id = "e2e-resend-0001" } = {}) {
  return { id };
}

/** Response body of Serper `/news`. */
export function serperNewsResponse(news = []) {
  return { news };
}

/** Response body of Serper `/search`. */
export function serperSearchResponse(organic = []) {
  return { organic };
}

/**
 * Response body of the Upstash Redis REST `/pipeline` endpoint, answering the
 * one command `@upstash/ratelimit` sends: an `evalsha` of the sliding-window
 * script, whose reply is `[remaining, effectiveLimit]`.
 *
 * ALWAYS ALLOWS, and does not count. Counting would be higher fidelity right up
 * until CI's `retries: 2` replayed a spec against a limit-5 bucket and turned a
 * flake into a hard 429 three tests later — state that survives a retry is
 * exactly what this tier is built to avoid. The limit echoed back is the route's
 * own configured limit, read out of the request, so `X-RateLimit-Limit` headers
 * and any "N remaining" copy still read correctly.
 *
 * `body` is the raw request body; the pipeline form is `[[cmd, ...args]]` and the
 * single-command form is `[cmd, ...args]`. ARGV[1] (the token budget) sits
 * directly after the three KEYS, which follow the `numkeys` argument.
 */
export function upstashPipelineResponse(body) {
  const commands = Array.isArray(body?.[0]) ? body : [body];
  const results = commands.map((cmd) => {
    // ["evalsha", <sha>, <numkeys>, ...keys, <tokens>, <now>, <window>, <incr>]
    const numKeys = Number(cmd?.[2]);
    const tokens = Number.isFinite(numKeys) ? Number(cmd?.[3 + numKeys]) : NaN;
    const limit = Number.isFinite(tokens) && tokens > 0 ? tokens : 1_000_000;
    return { result: [limit - 1, limit] };
  });
  return Array.isArray(body?.[0]) ? results : results[0];
}
