"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import {
  ChevronLeft, Briefcase, GraduationCap, MapPin,
  FileText, Clock, ExternalLink, Loader2, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AuthForm from "@/components/auth-form";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { decodeProfileData } from "@/lib/profile-encoding";
import { deriveCurrentRole } from "@/lib/profile-helpers";

type ProfileData = {
  first_name?: string;
  last_name?: string;
  name?: string;
  location?: { city?: string; state?: string; country?: string };
  industry?: string;
  generated_notes?: string;
  suggested_tags?: string[];
  experience?: Array<{
    company: string;
    title: string;
    location?: string;
    start_month?: string;
    end_month?: string;
    is_current?: boolean;
  }>;
  education?: Array<{
    school: string;
    degree?: string;
    field_of_study?: string;
    start_year?: string;
    end_year?: string;
  }>;
  contact_status?: string;
  expected_graduation?: string;
  linkedin_url?: string;
  follow_up_frequency?: string;
  current_company?: string;
  photo_url?: string;
  email?: string | null;
  contactInfo?: { email?: string };
};

export default function ContactPreviewPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const routerRef = useRef(router);
  routerRef.current = router;

  // Read profile data from URL hash once authenticated
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;

    const hash = window.location.hash;
    if (!hash || !hash.includes("data=")) {
      routerRef.current.push("/contacts");
      return;
    }

    let data: ProfileData;
    try {
      const encoded = hash.split("data=")[1];
      data = decodeProfileData(encoded) as ProfileData;
      setProfileData(data);
    } catch {
      routerRef.current.push("/contacts");
      return;
    }

    if (!data.linkedin_url) return;

    const controller = new AbortController();
    fetch("/api/contacts/check-duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkedinUrl: data.linkedin_url }),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.duplicates?.length > 0) {
          routerRef.current.replace(`/contacts/${result.duplicates[0].id}`);
        }
      })
      .catch(() => {
        // Ignore — aborted or network error, just show preview
      });

    return () => controller.abort();
  }, [user]);

  const handleSave = async () => {
    if (!profileData || saving) return;
    setSaving(true);
    setError(null);

    try {
      // Wrap top-level email into contactInfo so the import API can find it
      const payload = {
        profileData: {
          ...profileData,
          ...(profileData.email && !profileData.contactInfo
            ? { contactInfo: { email: profileData.email } }
            : {}),
        },
        photoUrl: profileData.photo_url,
      };
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();

      if (result.success && result.contact?.id) {
        setSaved(true);
        // Redirect to the saved contact page after a brief delay
        setTimeout(() => {
          router.push(`/contacts/${result.contact.id}`);
        }, 1500);
      } else {
        throw new Error(result.error || "Failed to save contact");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

  // Show spinner while auth is resolving to avoid flashing the login form
  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Show login form if not authenticated (hash data preserved across login)
  if (!user) {
    return <AuthForm />;
  }

  if (!profileData) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const fullName = profileData.name ||
    `${profileData.first_name || ""} ${profileData.last_name || ""}`.trim() ||
    "Unknown Contact";

  const locationStr = profileData.location
    ? [profileData.location.city, profileData.location.state, profileData.location.country]
        .filter(Boolean).join(", ")
    : "";

  const { current_company, current_title } = deriveCurrentRole(
    profileData.experience || []
  );

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Back button */}
        <button
          onClick={() => router.push("/contacts")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Contacts
        </button>

        {/* Header card */}
        <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            {/* Avatar + Identity */}
            <div className="flex items-center gap-4">
              <ContactAvatar name={fullName} photoUrl={profileData.photo_url} className="w-14 h-14 text-lg" />
              <div>
                <h1 className="text-2xl font-semibold text-foreground leading-tight">{fullName}</h1>
                {current_title && current_company && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {current_title} at {current_company}
                  </p>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3">
              {profileData.linkedin_url && (
                <a
                  href={profileData.linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-sm text-primary hover:underline px-3 py-1.5 rounded-lg hover:bg-primary/5 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  LinkedIn
                </a>
              )}
              {saved ? (
                <div className="flex items-center gap-2 text-green-700 px-4 py-2">
                  <Check className="w-5 h-5" />
                  <span className="font-medium text-sm">Saved! Redirecting...</span>
                </div>
              ) : (
                <Button onClick={handleSave} disabled={saving} className="min-w-[140px]">
                  {saving ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving...</>
                  ) : (
                    "Save to Contacts"
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Meta row: industry, location */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {profileData.industry && (
              <span>{profileData.industry}</span>
            )}
            {locationStr && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" /> {locationStr}
              </span>
            )}
            {profileData.follow_up_frequency && (
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> Follow up {profileData.follow_up_frequency.toLowerCase()}
              </span>
            )}
          </div>

          {/* Tags inline */}
          {profileData.suggested_tags && profileData.suggested_tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {profileData.suggested_tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2.5 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 mt-3">{error}</p>
          )}
        </div>

        {/* Content: two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sidebar: Notes */}
          <div className="lg:col-span-1 space-y-6">
            {profileData.generated_notes && (
              <div className="bg-surface-container-low rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">About</h2>
                </div>
                <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                  {profileData.generated_notes}
                </p>
              </div>
            )}
          </div>

          {/* Main content: Experience + Education */}
          <div className="lg:col-span-2 space-y-6">
            {/* Experience */}
            {profileData.experience && profileData.experience.length > 0 && (
              <div className="bg-surface-container-low rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Briefcase className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Experience</h2>
                </div>
                <div className="relative">
                  {/* Timeline line */}
                  <div className="absolute left-[5px] top-2 bottom-2 w-px bg-outline/50" />
                  <div className="space-y-5">
                    {profileData.experience.map((exp, i) => (
                      <div key={i} className="flex gap-4 relative">
                        {/* Timeline dot */}
                        <div className={`w-[11px] h-[11px] rounded-full mt-1.5 shrink-0 z-10 ${
                          i === 0 ? "bg-primary" : "bg-outline"
                        }`} />
                        <div className="min-w-0">
                          <p className="font-medium text-foreground leading-snug">{exp.title}</p>
                          <p className="text-sm text-muted-foreground">{exp.company}</p>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                            {(exp.start_month || exp.end_month) && (
                              <p className="text-xs text-muted-foreground">
                                {exp.start_month || "?"} — {exp.end_month || "Present"}
                              </p>
                            )}
                            {exp.location && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <MapPin className="w-3 h-3" /> {exp.location}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Education */}
            {profileData.education && profileData.education.length > 0 && (
              <div className="bg-surface-container-low rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <GraduationCap className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Education</h2>
                </div>
                <div className="space-y-4">
                  {profileData.education.map((edu, i) => (
                    <div key={i} className="flex gap-4">
                      <div className="w-[11px] h-[11px] rounded-full bg-outline mt-1.5 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-foreground leading-snug">{edu.school}</p>
                        {(edu.degree || edu.field_of_study) && (
                          <p className="text-sm text-muted-foreground">
                            {edu.degree}{edu.degree && edu.field_of_study ? " — " : ""}{edu.field_of_study}
                          </p>
                        )}
                        {(edu.start_year || edu.end_year) && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {edu.start_year || "?"} — {edu.end_year || "Present"}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
