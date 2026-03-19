"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import {
  ChevronLeft, User, Briefcase, GraduationCap, MapPin,
  FileText, Clock, ExternalLink, Loader2, Check, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AuthForm from "@/components/auth-form";
import { decodeProfileData } from "@/lib/profile-encoding";

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
};

export default function ContactPreviewPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedContactId, setSavedContactId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read profile data from URL hash once authenticated
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;

    const hash = window.location.hash;
    if (!hash || !hash.includes("data=")) {
      router.push("/contacts");
      return;
    }

    try {
      const encoded = hash.split("data=")[1];
      const data = decodeProfileData(encoded) as ProfileData;
      setProfileData(data);

      checkExisting(data);
    } catch {
      router.push("/contacts");
    }
  }, [router, user]);

  const checkExisting = async (data: ProfileData) => {
    if (!data.linkedin_url) return;
    try {
      const res = await fetch("/api/contacts/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl: data.linkedin_url }),
      });
      const result = await res.json();
      if (result.duplicates?.length > 0) {
        // Contact already exists — redirect to their page
        router.replace(`/contacts/${result.duplicates[0].id}`);
      }
    } catch {
      // Ignore — just show preview
    }
  };

  const handleSave = async () => {
    if (!profileData || saving) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileData }),
      });
      const result = await res.json();

      if (result.success && result.contact?.id) {
        setSaved(true);
        setSavedContactId(result.contact.id);
        // Redirect to the saved contact page after a brief delay
        setTimeout(() => {
          router.push(`/contacts/${result.contact.id}`);
        }, 1500);
      } else {
        throw new Error(result.error || "Failed to save contact");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

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

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Back button */}
        <button
          onClick={() => router.push("/contacts")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Contacts
        </button>

        {/* Header */}
        <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-foreground">{fullName}</h1>
                {profileData.industry && (
                  <p className="text-sm text-muted-foreground mt-1">{profileData.industry}</p>
                )}
                {locationStr && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                    <MapPin className="w-3 h-3" /> {locationStr}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {profileData.linkedin_url && (
                <a
                  href={profileData.linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  LinkedIn
                </a>
              )}
            </div>
          </div>

          {/* Preview badge */}
          <div className="mt-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4" />
            This contact is not yet saved in your CareerVine database.
          </div>
        </div>

        {/* Save bar */}
        <div className="bg-surface-container-low rounded-2xl p-4 mb-6 flex items-center justify-between">
          {saved ? (
            <div className="flex items-center gap-2 text-green-700">
              <Check className="w-5 h-5" />
              <span className="font-medium">Contact saved! Redirecting...</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Save this contact to start tracking interactions, meetings, and follow-ups.
              </p>
              <Button onClick={handleSave} disabled={saving} className="min-w-[140px]">
                {saving ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving...</>
                ) : (
                  "Save to Contacts"
                )}
              </Button>
            </>
          )}
          {error && (
            <p className="text-sm text-red-600 mt-2">{error}</p>
          )}
        </div>

        {/* Notes */}
        {profileData.generated_notes && (
          <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Notes</h2>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {profileData.generated_notes}
            </p>
          </div>
        )}

        {/* Tags */}
        {profileData.suggested_tags && profileData.suggested_tags.length > 0 && (
          <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
            <h2 className="text-lg font-semibold mb-3">Suggested Tags</h2>
            <div className="flex flex-wrap gap-2">
              {profileData.suggested_tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-3 py-1 text-xs font-medium bg-primary/10 text-primary rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Experience */}
        {profileData.experience && profileData.experience.length > 0 && (
          <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Briefcase className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Experience</h2>
            </div>
            <div className="space-y-4">
              {profileData.experience.map((exp, i) => (
                <div key={i} className="border-l-2 border-outline pl-4">
                  <p className="font-medium text-foreground">{exp.title}</p>
                  <p className="text-sm text-muted-foreground">{exp.company}</p>
                  {(exp.start_month || exp.end_month) && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {exp.start_month || "?"} — {exp.end_month || "Present"}
                    </p>
                  )}
                  {exp.location && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="w-3 h-3" /> {exp.location}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Education */}
        {profileData.education && profileData.education.length > 0 && (
          <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <GraduationCap className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Education</h2>
            </div>
            <div className="space-y-4">
              {profileData.education.map((edu, i) => (
                <div key={i} className="border-l-2 border-outline pl-4">
                  <p className="font-medium text-foreground">{edu.school}</p>
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
              ))}
            </div>
          </div>
        )}

        {/* Follow-up info */}
        {profileData.follow_up_frequency && (
          <div className="bg-surface-container-low rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Suggested follow-up: {profileData.follow_up_frequency}
              </span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
