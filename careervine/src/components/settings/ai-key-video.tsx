"use client";

/** Paste the Loom or self-hosted video URL here after recording. */
export const SETUP_VIDEO_URL: string | null = null;

function isLoomUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("loom.com");
  } catch {
    return false;
  }
}

function loomEmbedUrl(url: string): string | null {
  const match = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  return `https://www.loom.com/embed/${match[1]}`;
}

export default function AiKeyVideo() {
  if (!SETUP_VIDEO_URL) {
    return null;
  }

  const loomEmbed = isLoomUrl(SETUP_VIDEO_URL) ? loomEmbedUrl(SETUP_VIDEO_URL) : null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-medium text-foreground mb-3">
        Watch: set up your key in 2 minutes
      </h3>
      {loomEmbed ? (
        <div className="aspect-video rounded-xl overflow-hidden border border-outline-variant">
          <iframe
            src={loomEmbed}
            allowFullScreen
            className="w-full h-full"
            title="How to set up your OpenAI API key"
          />
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          className="w-full rounded-xl border border-outline-variant"
          src={SETUP_VIDEO_URL}
        />
      )}
    </div>
  );
}
