import type { PipelineJobApplication } from "@/lib/pipeline-preview-storage";
import { formatApplicationDateDisplay } from "@/lib/application-date-value";

export function applicationHasContent(application: PipelineJobApplication): boolean {
  return Boolean(
    application.jobTitle.trim() ||
      application.location.trim() ||
      application.dateApplied.trim() ||
      application.resumeFileId ||
      application.coverLetterFileId,
  );
}

export function formatApplicationSummaryLine(application: PipelineJobApplication): string | null {
  if (!applicationHasContent(application)) return null;

  const parts: string[] = [];
  const title = application.jobTitle.trim();
  if (title) parts.push(title);

  const location = application.location.trim();
  if (location) parts.push(location);

  const date = formatApplicationDateDisplay(application.dateApplied);
  if (date) parts.push(date);

  const docs: string[] = [];
  if (application.resumeFileId) docs.push("Resume");
  if (application.coverLetterFileId) docs.push("Cover letter");
  if (docs.length > 0) parts.push(docs.join(" + "));

  return parts.join(" · ");
}
