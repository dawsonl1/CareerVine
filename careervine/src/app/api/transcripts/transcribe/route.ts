import { withApiHandler, ApiError } from "@/lib/api-handler";
import { runWithDeepgramFallback } from "@/lib/deepgram";
import { transcriptTranscribeSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/transcripts/transcribe
 *
 * Transcribes an audio/video file using Deepgram with speaker diarization.
 * The file must already be uploaded to Supabase Storage.
 *
 * When meetingId is provided (editing an existing meeting), segments are saved
 * server-side. When omitted (creating a new meeting), only the transcription
 * results are returned for the client to save after meeting creation.
 *
 * Input:  { meetingId?: number, attachmentObjectPath: string }
 * Output: { segments: TranscriptSegment[], rawText: string }
 */
export const POST = withApiHandler({
  schema: transcriptTranscribeSchema,
  // CAR-51: spend cap — this route can fall back to the shared Deepgram key,
  // and 10 meeting transcriptions/hour is far above normal use.
  rateLimit: { bucket: "careervine-transcripts-transcribe", limit: 10, window: "1 h" },
  handler: async ({ user, body, track }) => {
    const { meetingId, attachmentObjectPath } = body;

    // Validate the user owns this storage path (paths are {userId}/{uuid}_{filename})
    if (!attachmentObjectPath.startsWith(`${user.id}/`) || attachmentObjectPath.includes("..")) {
      throw new ApiError("Invalid attachment path", 403);
    }

    const serviceClient = createSupabaseServiceClient();

    // Get signed URL and verify meeting ownership in parallel (when meetingId provided)
    const signedUrlPromise = serviceClient.storage
      .from("attachments")
      .createSignedUrl(attachmentObjectPath, 3600);

    const ownershipPromise = meetingId
      ? serviceClient
          .from("meetings")
          .select("id")
          .eq("id", meetingId)
          .eq("user_id", user.id)
          .single()
      : Promise.resolve({ data: null, error: null });

    const [signedUrlResult, ownershipResult] = await Promise.all([signedUrlPromise, ownershipPromise]);

    if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) {
      throw new ApiError("Failed to get signed URL for audio file", 500);
    }
    if (meetingId && (ownershipResult.error || !ownershipResult.data)) {
      throw new ApiError("Meeting not found", 404);
    }

    // Transcribe with per-user BYO Deepgram key routing + graceful fallback to
    // CareerVine's shared key. A rejected/out-of-credit user key is marked and
    // the call retried on the shared key inside the runner; if both fail, the
    // runner throws a friendly coded ApiError for the client to map.
    const signedUrl = signedUrlResult.data.signedUrl;
    const { segments, rawText } = await runWithDeepgramFallback(user.id, async (deepgram) => {
      const result = await deepgram.listen.v1.media.transcribeUrl({
        url: signedUrl,
        model: "nova-3",
        diarize: true,
        punctuate: true,
        smart_format: true,
        utterances: true,
      });

      // Map Deepgram utterances to our segment format
      const utterances = ("results" in result ? result.results?.utterances : undefined) ?? [];
      const segs = utterances.map((u: any, i: number) => ({
        speaker_label: `Speaker ${u.speaker}`,
        started_at: u.start ?? null,
        ended_at: u.end ?? null,
        content: u.transcript?.trim() ?? "",
        ordinal: i,
      }));

      // Build raw text for backward compat / search
      const raw = segs
        .map((s) => `${s.speaker_label}: ${s.content}`)
        .join("\n\n");

      return { segments: segs, rawText: raw };
    });

    // Only persist to DB when editing an existing meeting
    if (meetingId && segments.length > 0) {
      // Atomic replace via Postgres function (transaction-safe)
      const { error: rpcError } = await serviceClient.rpc("replace_transcript_segments", {
        p_meeting_id: meetingId,
        p_segments: segments.map((s: any) => ({
          ordinal: s.ordinal,
          speaker_label: s.speaker_label,
          started_at: s.started_at,
          ended_at: s.ended_at,
          content: s.content,
        })),
      });
      if (rpcError) {
        console.error("[transcribe] Segment replace error:", rpcError);
        throw new ApiError("Failed to save transcript segments", 500);
      }

      // Look up attachment ID from the storage path
      const { data: attachment } = await serviceClient
        .from("attachments")
        .select("id")
        .eq("object_path", attachmentObjectPath)
        .single();

      const { error: updateError } = await serviceClient
        .from("meetings")
        .update({
          transcript: rawText,
          transcript_source: "audio_deepgram",
          transcript_parsed: true,
          transcript_attachment_id: attachment?.id ?? null,
        })
        .eq("id", meetingId);
      if (updateError) {
        console.error("[transcribe] Meeting update error:", updateError);
      }
    }

    // After the work: a failed transcription must not count as processed (CAR-58).
    track("transcript_processed", { step: "transcribe" });
    return { segments, rawText };
  },
});
