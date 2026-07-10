import { formatApplicationsOpenDisplay } from "@/lib/applications-open-value";
import type { PipelineResearchingProgram } from "@/lib/pipeline-preview-storage";

export function programHasContent(program: PipelineResearchingProgram): boolean {
  return Boolean(
    program.name.trim() || program.appsOpen.trim() || program.jobPotential.trim(),
  );
}

export function formatProgramSummaryLine(program: PipelineResearchingProgram): string | null {
  if (!programHasContent(program)) return null;

  const parts: string[] = [];
  const name = program.name.trim();
  if (name) parts.push(name);

  const apps = formatApplicationsOpenDisplay(program.appsOpen);
  if (apps) parts.push(`Apps ${apps}`);

  const potential = program.jobPotential.trim();
  if (potential) parts.push(`${potential}/10`);

  return parts.join(" · ");
}
