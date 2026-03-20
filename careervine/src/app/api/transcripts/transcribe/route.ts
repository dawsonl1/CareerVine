import { createClient } from "@deepgram/sdk";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { transcriptTranscribeSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/transcripts/transcribe
 *
 * Transcribes an audio/video file using Deepgram with speaker diarization.
 * The file must already be uploaded to Supabase Storage.
 *
 * Input:  { meetingId: number, attachmentObjectPath: string }
 * Output: { segments: TranscriptSegment[], rawText: string }
 */
export const POST = withApiHandler({
  schema: transcriptTranscribeSchema,
  handler: async ({ user, body }) => {
    const { meetingId, attachmentObjectPath } = body;

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new ApiError("Deepgram API key not configured", 500);

    // Get a signed URL for the audio file from Supabase Storage
    const serviceClient = createSupabaseServiceClient();
    const { data: signedUrlData, error: urlError } = await serviceClient.storage
      .from("attachments")
      .createSignedUrl(attachmentObjectPath, 3600); // 1 hour expiry
    if (urlError || !signedUrlData?.signedUrl) {
      throw new ApiError("Failed to get signed URL for audio file", 500);
    }

    // Verify the user owns this meeting
    const { data: meeting, error: meetingError } = await serviceClient
      .from("meetings")
      .select("id")
      .eq("id", meetingId)
      .eq("user_id", user.id)
      .single();
    if (meetingError || !meeting) {
      throw new ApiError("Meeting not found", 404);
    }

    // Call Deepgram pre-recorded API with diarization
    const deepgram = createClient(apiKey);
    const { result, error: dgError } = await deepgram.listen.prerecorded.transcribeUrl(
      { url: signedUrlData.signedUrl },
      {
        model: "nova-3",
        diarize: true,
        punctuate: true,
        smart_format: true,
        utterances: true,
      },
    );

    if (dgError) {
      console.error("[transcribe] Deepgram error:", dgError);
      throw new ApiError("Transcription failed. Please try again.", 500);
    }

    // Map Deepgram utterances to our segment format
    const utterances = result?.results?.utterances ?? [];
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

    // Save segments to database
    if (segments.length > 0) {
      const rows = segments.map((s: any) => ({
        meeting_id: meetingId,
        ordinal: s.ordinal,
        speaker_label: s.speaker_label,
        contact_id: null,
        started_at: s.started_at,
        ended_at: s.ended_at,
        content: s.content,
      }));

      // Clear existing segments first
      await serviceClient
        .from("transcript_segments")
        .delete()
        .eq("meeting_id", meetingId);

      const { error: insertError } = await serviceClient
        .from("transcript_segments")
        .insert(rows);
      if (insertError) {
        console.error("[transcribe] Segment insert error:", insertError);
        throw new ApiError("Failed to save transcript segments", 500);
      }
    }

    // Update meeting with raw transcript and metadata
    await serviceClient
      .from("meetings")
      .update({
        transcript: rawText,
        transcript_source: "audio_deepgram",
        transcript_parsed: true,
      })
      .eq("id", meetingId);

    return { segments, rawText };
  },
});
