"use client";

import { Plus, Trash2 } from "lucide-react";
import { ApplicationDatePicker } from "@/components/ui/application-date-picker";
import { PipelinePdfUploadField } from "@/components/companies/location-first-preview/pipeline-pdf-upload";
import {
  createJobApplicationId,
  type PipelineJobApplication,
} from "@/lib/pipeline-preview-storage";

const inputClassName =
  "w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-on-surface-variant">{label}</label>
      {children}
    </div>
  );
}

function ApplicationCard({
  application,
  index,
  companyId,
  isCompanyScope,
  defaultLocation,
  onChange,
  onDelete,
}: {
  application: PipelineJobApplication;
  index: number;
  companyId: number;
  isCompanyScope: boolean;
  defaultLocation: string;
  onChange: (patch: Partial<PipelineJobApplication>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-high/25 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant pt-0.5">
          Application {index + 1}
        </p>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove application"
          className="p-1.5 rounded-md text-on-surface-variant/70 hover:text-error hover:bg-error-container/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <FieldRow label="Job or role">
        <input
          type="text"
          value={application.jobTitle}
          onChange={(e) => onChange({ jobTitle: e.target.value })}
          placeholder="e.g. IB Analyst, S&T Summer"
          className={inputClassName}
        />
      </FieldRow>
      <FieldRow label="Location">
        {isCompanyScope ? (
          <input
            type="text"
            value={application.location}
            onChange={(e) => onChange({ location: e.target.value })}
            placeholder={index === 0 ? "General application or office" : "Office or program"}
            className={inputClassName}
          />
        ) : (
          <p className="text-sm text-on-surface-variant py-1.5">
            {application.location.trim() || defaultLocation}
          </p>
        )}
      </FieldRow>
      <FieldRow label="Date applied">
        <ApplicationDatePicker
          value={application.dateApplied}
          onChange={(dateApplied) => onChange({ dateApplied })}
          placeholder="Select date applied"
          dialogTitle="Date applied"
          dialogDescription="When you submitted this application"
        />
      </FieldRow>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Resume (PDF)">
          <PipelinePdfUploadField
            companyId={companyId}
            fileId={application.resumeFileId}
            onFileIdChange={(resumeFileId) => onChange({ resumeFileId })}
          />
        </FieldRow>
        <FieldRow label="Cover letter (PDF)">
          <PipelinePdfUploadField
            companyId={companyId}
            fileId={application.coverLetterFileId}
            onFileIdChange={(coverLetterFileId) => onChange({ coverLetterFileId })}
          />
        </FieldRow>
      </div>
    </div>
  );
}

export function AppliedApplicationsEditor({
  companyId,
  applications,
  isCompanyScope,
  defaultLocation,
  onChange,
}: {
  companyId: number;
  applications: PipelineJobApplication[];
  isCompanyScope: boolean;
  defaultLocation: string;
  onChange: (applications: PipelineJobApplication[]) => void;
}) {
  const addApplication = () => {
    onChange([
      ...applications,
      {
        id: createJobApplicationId(),
        jobTitle: "",
        location: isCompanyScope ? "" : defaultLocation,
        dateApplied: "",
        resumeFileId: null,
        coverLetterFileId: null,
      },
    ]);
  };

  const updateApplication = (id: string, patch: Partial<PipelineJobApplication>) => {
    onChange(applications.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const deleteApplication = (id: string) => {
    onChange(applications.filter((a) => a.id !== id));
  };

  return (
    <div className="space-y-3">
      {applications.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          Add each job or program you&apos;ve applied to at this company.
        </p>
      ) : (
        <ul className="space-y-3">
          {applications.map((application, index) => (
            <li key={application.id}>
              <ApplicationCard
                application={application}
                index={index}
                companyId={companyId}
                isCompanyScope={isCompanyScope}
                defaultLocation={defaultLocation}
                onChange={(patch) => updateApplication(application.id, patch)}
                onDelete={() => deleteApplication(application.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addApplication}
        className="inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-0.5 -ml-0.5"
      >
        <Plus className="w-3.5 h-3.5" />
        {applications.length === 0 ? "Add application" : "Add another application"}
      </button>
    </div>
  );
}
