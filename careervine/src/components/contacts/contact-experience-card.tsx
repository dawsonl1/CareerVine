"use client";

import type { Contact } from "@/lib/types";
import { Briefcase, GraduationCap } from "lucide-react";

interface ContactExperienceCardProps {
  contact: Contact;
}

export function ContactExperienceCard({ contact }: ContactExperienceCardProps) {
  const hasCompanies = contact.contact_companies.length > 0;
  const hasSchools = contact.contact_schools.length > 0;

  if (!hasCompanies && !hasSchools) return null;

  return (
    <div className="rounded-[16px] border border-outline-variant p-6 space-y-5">
      {/* Work history */}
      {hasCompanies && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
            Experience
          </h3>
          {contact.contact_companies.map((cc) => (
            <div
              key={cc.id}
              className="flex gap-3 py-2"
            >
              <Briefcase className={`h-5 w-5 shrink-0 mt-0.5 ${cc.is_current ? "text-primary" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <p className="text-base text-foreground font-medium leading-tight">
                  {cc.title || cc.companies.name}
                </p>
                {cc.title && (
                  <p className="text-sm text-muted-foreground">{cc.companies.name}</p>
                )}
                <p className="text-sm text-muted-foreground">
                  {(cc as any).start_month && (
                    <>
                      {(cc as any).start_month} – {cc.is_current ? "Present" : (cc as any).end_month || ""}
                    </>
                  )}
                  {(cc as any).location && (
                    <>
                      {(cc as any).start_month && " · "}
                      {(cc as any).location}
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Education */}
      {hasSchools && (
        <div className="space-y-1.5">
          {hasCompanies && <div className="border-t border-outline-variant pt-4" />}
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
            Education
          </h3>
          {contact.contact_schools.map((cs) => (
            <div key={cs.id} className="flex gap-3 py-2">
              <GraduationCap className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-base text-foreground font-medium leading-tight">
                  {cs.schools.name}
                </p>
                {(cs.degree || cs.field_of_study) && (
                  <p className="text-sm text-muted-foreground">
                    {cs.degree}
                    {cs.degree && cs.field_of_study ? " in " : ""}
                    {cs.field_of_study}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
