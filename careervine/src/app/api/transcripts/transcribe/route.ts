import { DeepgramClient } from "@deepgram/sdk";
import { withApiHandler, ApiError } from "@/lib/api-handler";
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
  handler: async ({ user, body }) => {
    const { meetingId, attachmentObjectPath } = body;

    // Validate the user owns this storage path (paths are {userId}/{uuid}_{filename})
    if (!attachmentObjectPath.startsWith(`${user.id}/`) || attachmentObjectPath.includes("..")) {
      throw new ApiError("Invalid attachment path", 403);
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new ApiError("Deepgram API key not configured", 500);

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

    // Call Deepgram pre-recorded API with diarization
    const deepgram = new DeepgramClient({ apiKey });
    let result;
    try {
      result = await deepgram.listen.v1.media.transcribeUrl({
        url: signedUrlResult.data.signedUrl,
        model: "nova-3",
        diarize: true,
        punctuate: true,
        smart_format: true,
        utterances: true,
      });
    } catch (dgError) {
      console.error("[transcribe] Deepgram error:", dgError);
      throw new ApiError("Transcription failed. Please try again.", 500);
    }

    // Map Deepgram utterances to our segment format
    const utterances = ("results" in result ? result.results?.utterances : undefined) ?? [];
    const segments = utterances.map((u: any, i: number) => ({
      speaker_label: `Speaker ${u.speaker}`,
      started_at: u.start ?? null,
      ended_at: u.end ?? null,
      content: u.transcript?.trim() ?? "",
      ordinal: i,
    }));

    // Build raw text for backward compat / search
    const rawText = segments
      .map((s: any) => `${s.speaker_label}: ${s.content}`)
      .join("\n\n");

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

    return { segments, rawText };
  },
});
