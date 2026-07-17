import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  ArrowLeft,
  Briefcase,
  Clock,
  FileText,
  GraduationCap,
  Loader2,
  MapPin,
  User,
  ExternalLink,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Sprout,
  X,
  Pencil,
  AlertTriangle,
  Sparkles,
  CloudOff,
  Hourglass,
} from "lucide-react";
import { isRateLimited, rateLimitedCopy } from "./rate-limit-copy";
import { AI_FAILURE_COPY, mapAiFailure, type AiFailureCode } from "./ai-failure";

import {
  MONTH_ABBREVS,
  calcDuration,
  deriveContactStatus,
  standardizeLocation,
  standardizeMonth,
} from "./lib/profile-format";

/** Turn a raw auth error into something a user can act on. */
function friendlyAuthError(message?: string): string {
  const m = (message || "").toLowerCase();
  if (m.includes("invalid") || m.includes("credentials")) {
    return "That email or password is incorrect. Please try again.";
  }
  if (m.includes("network") || m.includes("failed to fetch")) {
    return "Could not reach CareerVine. Check your connection and try again.";
  }
  return message || "Sign in failed. Please try again.";
}

type Location = {
  city: string | null;
  state: string | null;
  country: string | null;
};

type Experience = {
  id: string;
  company: string;
  title: string;
  location?: string | null;
  start_month: string | null;
  end_month: string | null;
  is_current?: boolean;
};

type Education = {
  id: string;
  school: string;
  degree: string;
  field_of_study: string;
  start_year: string | null;
  end_year: string | null;
  is_current?: boolean;
};

type ProfileData = {
  first_name: string | null;
  last_name: string | null;
  name?: string;
  location: Location;
  industry: string | null;
  generated_notes: string | null;
  suggested_tags: string[];
  experience: Experience[];
  education: Education[];
  contact_status: "student" | "professional" | null;
  expected_graduation: string | null;
  linkedin_url?: string | null;
  follow_up_frequency?: string | null;
  current_company?: string | null;
  email?: string | null;
};

const FOLLOW_UP_OPTIONS = [
  "No follow-up",
  "2 weeks",
  "2 months",
  "3 months",
  "6 months",
  "1 year",
];

const enrichProfile = (data: Partial<ProfileData> | null): ProfileData | null => {
  if (!data) return null;
  const experience = (data.experience ?? []).map((exp, index) => ({
    id: (exp as Experience)?.id ?? `${Date.now()}-${index}`,
    company: exp.company ?? "",
    title: exp.title ?? "",
    location: (exp as any).location ?? "",
    start_month: exp.start_month ?? "",
    end_month: exp.end_month ?? "",
    is_current: exp.is_current ?? exp.end_month === "Present",
  }));

  const currentExp = experience.find(e => e.is_current);

  const education = (data.education ?? []).map((edu, index) => ({
    id: (edu as Education)?.id ?? `${Date.now()}-edu-${index}`,
    school: edu.school ?? "",
    degree: edu.degree ?? "",
    field_of_study: edu.field_of_study ?? "",
    start_year: edu.start_year ?? "",
    end_year: edu.end_year ?? "",
    is_current: edu.is_current ?? edu.end_year === "Present",
  }));

  // Auto-derive contact_status if not already set
  let contactStatus = data.contact_status;
  let expectedGraduation = data.expected_graduation;
  if (!contactStatus) {
    const derived = deriveContactStatus(education);
    contactStatus = derived.contact_status;
    expectedGraduation = derived.expected_graduation;
  }

  return {
    first_name: data.first_name ?? "",
    last_name: data.last_name ?? "",
    name: data.name ?? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim(),
    location: {
      city: data.location?.city ?? "",
      state: data.location?.state ?? "",
      country: data.location?.country ?? null,
    },
    industry: data.industry ?? "",
    generated_notes: data.generated_notes ?? "",
    suggested_tags: data.suggested_tags ?? [],
    experience,
    education,
    contact_status: contactStatus ?? "professional",
    expected_graduation: expectedGraduation ?? "",
    linkedin_url: data.linkedin_url ?? "",
    follow_up_frequency: data.follow_up_frequency ?? "",
    current_company: currentExp?.company ?? null,
    email: data.email ?? null,
  };
};

// Format a date range with duration: "Aug 2024 - Jul 2025 · 1 yr"
const formatDateRange = (start: string | null, end: string | null): string => {
  if (!start) return "";
  
  const startFormatted = standardizeMonth(start);
  const endFormatted = end ? standardizeMonth(end) : "Present";
  const duration = calcDuration(start, end || "Present");
  
  if (duration) {
    return `${startFormatted} - ${endFormatted} · ${duration}`;
  }
  return `${startFormatted} - ${endFormatted}`;
};

// Calculate duration for education (Year only format)
const calcEducationDuration = (startYear: string | null, endYear: string | null): string => {
  if (!startYear) return "";
  
  const start = parseInt(startYear);
  if (isNaN(start)) return "";
  
  const end = endYear === "Present" ? new Date().getFullYear() : parseInt(endYear || "");
  if (isNaN(end)) return "";
  
  const years = end - start;
  if (years > 0) return `${years} yr`;
  return "";
};

// Format education date range: "2018 - 2024 · 6 yr"
const formatEducationDateRange = (startYear: string | null, endYear: string | null): string => {
  if (!startYear) return "";
  
  const endFormatted = endYear || "Present";
  const duration = calcEducationDuration(startYear, endYear || "Present");
  
  if (duration) {
    return `${startYear} - ${endFormatted} · ${duration}`;
  }
  return `${startYear} - ${endFormatted}`;
};

// Hook: close a dropdown/popover when clicking outside its ref (works in Shadow DOM)
const useClickOutside = (ref: React.RefObject<HTMLElement | null>, onClose: () => void, isOpen: boolean) => {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const root = (window as any).__cv_sr || document;
    const timer = setTimeout(() => root.addEventListener("mousedown", handler), 10);
    return () => { clearTimeout(timer); root.removeEventListener("mousedown", handler); };
  }, [isOpen]);
};

// Simple Dropdown Component
const SimpleDropdown: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}> = ({ value, onChange, options, placeholder = "Select...", className = "" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };

  const handleSelect = (option: string) => {
    onChange(option);
    setIsOpen(false);
  };

  return (
    <div ref={dropdownRef} className={`cv-custom-dropdown ${className}`}>
      <button
        type="button"
        className={`cv-dropdown-trigger ${!value ? 'cv-dropdown-placeholder' : ''}`}
        onClick={handleToggle}
      >
        <span>{value || placeholder}</span>
        <svg 
          className={`cv-dropdown-arrow ${isOpen ? 'cv-dropdown-arrow-open' : ''}`}
          width="12" 
          height="12" 
          viewBox="0 0 12 12"
          fill="none"
        >
          <path 
            d="M3 4.5L6 7.5L9 4.5" 
            stroke="currentColor" 
            strokeWidth="1.5" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          />
        </svg>
      </button>
      
      {isOpen && (
        <div className="cv-dropdown-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={`cv-dropdown-option ${option === value ? 'cv-dropdown-option-selected' : ''}`}
              onClick={() => handleSelect(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};


// Auto Resize Textarea Component
const AutoResizeTextarea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
}> = ({ value, onChange, placeholder, className = "", minHeight = 60 }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set height to scrollHeight, but not less than minHeight
      const newHeight = Math.max(textarea.scrollHeight, minHeight);
      textarea.style.height = `${newHeight}px`;
    }
  }, [value, minHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      style={{
        minHeight: `${minHeight}px`,
        resize: 'none',
        overflow: 'hidden'
      }}
    />
  );
};


// Inline edit input — looks like display text, reveals as editable on focus
const InlineInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}> = ({ value, onChange, placeholder, className = "" }) => (
  <input
    type="text"
    className={`cv-inline-input ${className}`}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
  />
);

// Contact status toggle — reused in view mode and edit mode
const StatusToggle: React.FC<{
  value: "student" | "professional" | null;
  onChange: (status: "student" | "professional") => void;
}> = ({ value, onChange }) => (
  <div className="cv-status-toggle-row">
    <button
      type="button"
      className={`cv-status-toggle-btn ${value === 'student' ? 'cv-status-active' : ''}`}
      onClick={() => onChange('student')}
    >
      <GraduationCap className="w-4 h-4" />
      Student
    </button>
    <button
      type="button"
      className={`cv-status-toggle-btn ${value === 'professional' ? 'cv-status-active' : ''}`}
      onClick={() => onChange('professional')}
    >
      <Briefcase className="w-4 h-4" />
      Professional
    </button>
  </div>
);

// Month/Year picker — inline input with dropdown suggestions
const MonthYearPicker: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  yearOnly?: boolean;
}> = ({ value, onChange, placeholder, className = "", yearOnly = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setInputVal(value); }, [value]);
  useClickOutside(wrapperRef, () => setIsOpen(false), isOpen);

  const currentYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: 30 }, (_, i) => currentYear - i), [currentYear]);

  const getSuggestions = (): string[] => {
    const q = inputVal.toLowerCase().trim();

    if (yearOnly) {
      const filtered = years.filter(y => String(y).includes(q));
      return (q === "" ? filtered.slice(0, 8) : filtered.slice(0, 6)).map(String);
    }

    // Month+year suggestions
    const suggestions: string[] = [];
    if ("present".startsWith(q) && q !== "") suggestions.push("Present");

    for (const y of years.slice(0, 10)) {
      for (const m of MONTH_ABBREVS) {
        const label = `${m} ${y}`;
        if (q === "" || label.toLowerCase().includes(q) || m.toLowerCase().startsWith(q)) {
          suggestions.push(label);
        }
        if (suggestions.length >= 8) break;
      }
      if (suggestions.length >= 8) break;
    }
    if (q === "" && !suggestions.includes("Present")) suggestions.unshift("Present");
    return suggestions.slice(0, 8);
  };

  const handleSelect = (val: string) => {
    onChange(val);
    setInputVal(val);
    setIsOpen(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(e.target.value);
    setIsOpen(true);
  };

  const handleBlur = () => {
    // Commit whatever is typed on blur
    setTimeout(() => {
      if (inputVal !== value) onChange(inputVal);
      setIsOpen(false);
    }, 150);
  };

  const suggestions = isOpen ? getSuggestions() : [];

  return (
    <div ref={wrapperRef} className="cv-date-picker-wrapper">
      <span className="cv-auto-size-wrapper">
        <span className={`cv-auto-size-sizer ${className}`}>
          {inputVal || placeholder}
        </span>
        <input
          type="text"
          size={1}
          className={`cv-inline-input ${className}`}
          value={inputVal}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onBlur={handleBlur}
          placeholder={placeholder}
        />
      </span>
      {isOpen && suggestions.length > 0 && (
        <div className="cv-date-suggestions">
          {suggestions.map(s => (
            <button
              key={s}
              type="button"
              className={`cv-date-suggestion ${s === value ? 'cv-date-suggestion-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(s); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Edit Panel Component
const EditPanel: React.FC<{
  profile: ProfileData;
  onChange: (field: string, value: any) => void;
  onSave: () => void;
  onCancel: () => void;
  onAddExperience: () => void;
  onRemoveExperience: (index: number) => void;
  onAddEducation: () => void;
  onRemoveEducation: (index: number) => void;
}> = ({
  profile,
  onChange,
  onSave,
  onCancel,
  onAddExperience,
  onRemoveExperience,
  onAddEducation,
  onRemoveEducation,
}) => {
  return (
    <div className="cv-panel cv-panel-editing">
      {/* Header */}
      <header className="cv-header">
        <button className="cv-back-btn" onClick={onCancel}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="cv-header-title">Editing</h2>
      </header>

      {/* Main Content */}
      <main className="cv-main">
        {/* Profile Section — mirrors view layout */}
        <section className="cv-profile-section">
          <div className="cv-avatar">
            <User className="w-8 h-8 text-green-700" />
          </div>
          <div className="cv-profile-info">
            <InlineInput
              value={profile.name || ""}
              onChange={(v) => onChange('name', v)}
              placeholder="Name"
              className="cv-inline-name"
            />
            <InlineInput
              value={profile.industry || ""}
              onChange={(v) => onChange('industry', v)}
              placeholder="Industry"
              className="cv-inline-industry"
            />
          </div>
        </section>

        {/* Contact Status Toggle */}
        <StatusToggle
          value={profile.contact_status}
          onChange={(status) => onChange('contact_status', status)}
        />

        {/* Quick Info — same icon rows as view mode */}
        <div className="cv-quick-info">
          <div className="cv-info-row">
            <MapPin />
            <InlineInput
              value={profile?.location?.city || ""}
              onChange={(v) => onChange('location.city', v)}
              placeholder="City, State"
              className="cv-inline-meta"
            />
          </div>
          <div className="cv-info-row">
            <Mail />
            <InlineInput
              value={profile.email || ""}
              onChange={(v) => onChange('email', v)}
              placeholder="Email address"
              className="cv-inline-meta"
            />
          </div>
          <div className="cv-info-row">
            <Clock />
            <SimpleDropdown
              value={profile.follow_up_frequency || ""}
              onChange={(value) => onChange('follow_up_frequency', value)}
              options={FOLLOW_UP_OPTIONS}
              placeholder="Follow-up frequency"
              className="cv-edit-followup"
            />
          </div>
          <div className="cv-info-row cv-notes-row">
            <FileText />
            <AutoResizeTextarea
              value={profile.generated_notes || ""}
              onChange={(value) => onChange('generated_notes', value)}
              placeholder="Add notes..."
              className="cv-inline-notes"
              minHeight={40}
            />
          </div>
        </div>

        {/* Experience Section */}
        <section className="cv-section">
          <div className="cv-section-header">
            <Briefcase className="w-5 h-5" />
            <h2>Experience</h2>
            <button type="button" className="cv-add-remove-btn cv-add-btn" onClick={onAddExperience}>+</button>
          </div>
          <div className="cv-experience-list">
            {profile.experience.map((exp, index) => (
              <div key={exp.id} className="cv-job-item cv-editable-item">
                <div className="cv-editable-item-content">
                  <InlineInput
                    value={exp.title || ""}
                    onChange={(v) => onChange(`experience.${index}.title`, v)}
                    placeholder="Job Title"
                    className="cv-inline-job-title"
                  />
                  <InlineInput
                    value={exp.company || ""}
                    onChange={(v) => onChange(`experience.${index}.company`, v)}
                    placeholder="Company"
                    className="cv-inline-job-company"
                  />
                  <div className="cv-inline-date-row">
                    <MonthYearPicker
                      value={exp.start_month || ""}
                      onChange={(v) => onChange(`experience.${index}.start_month`, v)}
                      placeholder="Start"
                      className="cv-inline-date"
                    />
                    <span className="cv-inline-date-sep">{'\u2013'}</span>
                    <MonthYearPicker
                      value={exp.end_month || ""}
                      onChange={(v) => onChange(`experience.${index}.end_month`, v)}
                      placeholder="End"
                      className="cv-inline-date"
                    />
                  </div>
                  <InlineInput
                    value={exp.location || ""}
                    onChange={(v) => onChange(`experience.${index}.location`, v)}
                    placeholder="Location"
                    className="cv-inline-job-location"
                  />
                </div>
                <button
                  type="button"
                  className="cv-add-remove-btn cv-remove-btn"
                  onClick={() => onRemoveExperience(index)}
                >{'\u2014'}</button>
              </div>
            ))}
          </div>
        </section>

        {/* Education Section */}
        <section className="cv-section cv-education-section">
          <div className="cv-section-header">
            <GraduationCap className="w-5 h-5" />
            <h2>Education</h2>
            <button type="button" className="cv-add-remove-btn cv-add-btn" onClick={onAddEducation}>+</button>
          </div>
          <div className="cv-education-list">
            {profile.education.map((edu, index) => (
              <div key={edu.id} className="cv-edu-item cv-editable-item">
                <div className="cv-editable-item-content">
                  <InlineInput
                    value={edu.school || ""}
                    onChange={(v) => onChange(`education.${index}.school`, v)}
                    placeholder="School"
                    className="cv-inline-edu-school"
                  />
                  <div className="cv-inline-degree-row">
                    <InlineInput
                      value={edu.degree || ""}
                      onChange={(v) => onChange(`education.${index}.degree`, v)}
                      placeholder="Degree"
                      className="cv-inline-edu-degree"
                    />
                    <InlineInput
                      value={edu.field_of_study || ""}
                      onChange={(v) => onChange(`education.${index}.field_of_study`, v)}
                      placeholder="Field of study"
                      className="cv-inline-edu-degree"
                    />
                  </div>
                  <div className="cv-inline-date-row">
                    <MonthYearPicker
                      value={edu.start_year || ""}
                      onChange={(v) => onChange(`education.${index}.start_year`, v)}
                      placeholder="Start"
                      className="cv-inline-date"
                      yearOnly
                    />
                    <span className="cv-inline-date-sep">{'\u2013'}</span>
                    <MonthYearPicker
                      value={edu.end_year || ""}
                      onChange={(v) => onChange(`education.${index}.end_year`, v)}
                      placeholder="End"
                      className="cv-inline-date"
                      yearOnly
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="cv-add-remove-btn cv-remove-btn"
                  onClick={() => onRemoveEducation(index)}
                >{'\u2014'}</button>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="cv-edit-footer">
        <button className="cv-cancel-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="cv-save-edit-btn" onClick={onSave}>
          Save
        </button>
      </footer>
    </div>
  );
};

const App: React.FC = () => {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedProfile, setEditedProfile] = useState<ProfileData | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [autoScrape, setAutoScrape] = useState(false);
  const [progressStage, setProgressStage] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [onProfilePage, setOnProfilePage] = useState(
    typeof window !== 'undefined' && window.location?.href?.includes('linkedin.com/in/')
  );
  const [savedContactId, setSavedContactId] = useState<number | null>(null);
  // Null until the env config loads (see the getConfig effect). Never a
  // hardcoded production default, so a dev build never links to production.
  const [webappBaseUrl, setWebappBaseUrl] = useState<string | null>(null);
  const [existingContact, setExistingContact] = useState<any>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [aiFailure, setAiFailure] = useState<AiFailureCode | null>(null);
  
  const checkAuthentication = async () => {
    try {
      const response = await chrome?.runtime?.sendMessage?.({
        action: "checkAuth",
      });
      setIsAuthenticated(response?.authenticated || false);
      return response?.authenticated || false;
    } catch (error) {
      console.error("Failed to check authentication", error);
      setIsAuthenticated(false);
      return false;
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authLoading) return;
    setAuthError(null);
    setAuthLoading(true);

    try {
      const response = await chrome?.runtime?.sendMessage?.({
        action: "authenticate",
        credentials: { email, password }
      });

      if (response?.success) {
        setEmail("");
        setPassword("");
        setIsAuthenticated(true);
        // Ask the content script to push current page state now that we can
        // make authenticated calls (DB check, cache, optional auto-scrape).
        (window as any).__cv_bus?.dispatchEvent(new CustomEvent("panel-ready"));
      } else {
        setAuthError(friendlyAuthError(response?.error));
        setAuthLoading(false);
      }
    } catch (error) {
      console.error("Login error", error);
      setAuthError("Could not reach CareerVine. Check your connection and try again.");
      setAuthLoading(false);
    }
  };

  // Load auto-scrape setting and webapp base URL
  useEffect(() => {
    chrome?.storage?.local?.get?.(['autoScrapeEnabled'], (result: any) => {
      setAutoScrape(result?.autoScrapeEnabled || false);
    });
    // Get webapp URL from config (strips a trailing /api, with or without a
    // trailing slash, from apiBaseUrl).
    chrome?.runtime?.sendMessage?.({ action: 'getConfig' }, (response: any) => {
      if (response?.apiBaseUrl) {
        setWebappBaseUrl(response.apiBaseUrl.replace(/\/api\/?$/, ''));
      }
    });
  }, []);

  const handleToggleAutoScrape = (enabled: boolean) => {
    setAutoScrape(enabled);
    chrome?.storage?.local?.set?.({ autoScrapeEnabled: enabled });
  };

  const handleRequestScrape = () => {
    const bus = (window as any).__cv_bus;
    if (bus) {
      bus.dispatchEvent(new CustomEvent('request-scrape'));
    }
  };

  useEffect(() => {
    checkAuthentication();

    // Shared state reset — prevents copy-paste drift between handlers
    const resetState = (onProfile: boolean) => {
      setProfile(null);
      setLoading(false);
      setAnalyzing(false);
      setOnProfilePage(onProfile);
      setSavedContactId(null);
      setExistingContact(null);
      setStatusText(null);
      setErrorText(null);
      setProgressStage(null);
      setProgressPercent(0);
      setPhotoUrl(null);
      setPhotoError(false);
      setAiFailure(null);
    };

    // Scrape finished in THIS tab — content.js hands the parsed profile
    // straight over the bus (no global storage, so no cross-tab bleed).
    const handleProfileData = (event: CustomEvent) => {
      const newProfile = enrichProfile(event.detail?.profileData ?? null);
      if (newProfile) {
        setProfile(newProfile);
        setLoading(false);
      }
      setPhotoUrl(event.detail?.photoUrl || null);
      setPhotoError(false);
    };

    const handleAnalyzing = (event: CustomEvent) => {
      setAnalyzing(event.detail.analyzing);
      if (event.detail.analyzing) {
        setLoading(true);
        setProfile(null);
        setStatusText(null);
        setErrorText(null);
        setAiFailure(null);
        setProgressStage('starting');
        setProgressPercent(0);
      } else {
        setTimeout(() => {
          setLoading((prev) => prev ? false : prev);
        }, 500);
      }
    };

    const handleProgress = (event: CustomEvent) => {
      setProgressStage(event.detail.stage);
      setProgressPercent(event.detail.percent);
    };

    const handleNewProfile = () => resetState(true);
    const handleLeftProfile = () => resetState(false);

    const handleCacheHit = (event: CustomEvent) => {
      resetState(true);
      const cachedProfile = enrichProfile(event.detail?.profileData ?? null);
      if (cachedProfile) {
        setProfile(cachedProfile);
        setLoading(false);
        setPhotoUrl(event.detail?.photoUrl || null);
        setPhotoError(false);
        // DB match check handled by content.js checkProfileInDB — no duplicate call
      } else {
        setLoading(true);
      }
    };

    // DB match — contact already exists in CareerVine
    const handleDBMatch = (event: CustomEvent) => {
      const contact = event.detail?.contact;
      if (contact) {
        setExistingContact(contact);
        setSavedContactId(contact.id);
        setOnProfilePage(true);
        setStatusText(null);
        setErrorText(null);
      }
    };

    // DB no match — new contact
    const handleDBNoMatch = () => {
      setExistingContact(null);
      setSavedContactId(null);
      setOnProfilePage(true);
    };

    // Parse failed server-side. AI-availability failures (402, CAR-26) get a
    // specific graceful state, rate limiting (429, CAR-41) gets minutes-until-
    // reset copy; anything else surfaces its message instead of dead-ending on
    // the misleading "Ready to analyze" empty state.
    const handleParseError = (event: CustomEvent) => {
      const detail = event.detail || {};
      const code = mapAiFailure(detail.status, detail.code);
      if (code) {
        setAiFailure(code);
        setErrorText(null);
      } else if (isRateLimited(detail.status, detail.code)) {
        setErrorText(rateLimitedCopy(detail.resetAt));
      } else {
        setErrorText(detail.message || "Couldn't analyze this profile. Please try again.");
      }
      setProfile(null);
      setLoading(false);
    };

    const bus = (window as any).__cv_bus;
    bus?.addEventListener('profiledata', handleProfileData as EventListener);
    bus?.addEventListener('analyzing', handleAnalyzing as EventListener);
    bus?.addEventListener('progress', handleProgress as EventListener);
    bus?.addEventListener('newprofile', handleNewProfile as EventListener);
    bus?.addEventListener('leftprofile', handleLeftProfile as EventListener);
    bus?.addEventListener('cachedhit', handleCacheHit as EventListener);
    bus?.addEventListener('dbmatch', handleDBMatch as EventListener);
    bus?.addEventListener('dbnomatch', handleDBNoMatch as EventListener);
    bus?.addEventListener('parseerror', handleParseError as EventListener);

    // Listeners are attached — content.js can now push the current page's
    // state (DB check, cached profile, auto-scrape) without racing the mount.
    bus?.dispatchEvent(new CustomEvent('panel-ready'));

    return () => {
      bus?.removeEventListener('profiledata', handleProfileData as EventListener);
      bus?.removeEventListener('analyzing', handleAnalyzing as EventListener);
      bus?.removeEventListener('progress', handleProgress as EventListener);
      bus?.removeEventListener('newprofile', handleNewProfile as EventListener);
      bus?.removeEventListener('leftprofile', handleLeftProfile as EventListener);
      bus?.removeEventListener('cachedhit', handleCacheHit as EventListener);
      bus?.removeEventListener('dbmatch', handleDBMatch as EventListener);
      bus?.removeEventListener('dbnomatch', handleDBNoMatch as EventListener);
      bus?.removeEventListener('parseerror', handleParseError as EventListener);
    };
  }, []);

  const handleSaveContact = async () => {
    if (!profile) return;
    setSaving(true);
    setStatusText(null);
    setErrorText(null);

    try {
      const payload = {
        ...profile,
        name: profile.name || `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim(),
        contactInfo: profile.email ? { email: profile.email } : undefined,
      };
      const response = await chrome?.runtime?.sendMessage?.({
        action: "importData",
        data: payload,
        photoUrl: photoUrl,
      });

      if (response?.success) {
        setStatusText("Contact saved to CareerVine.");
        setTimeout(() => setStatusText(null), 5000);
        if (response?.data?.contact?.id) {
          setSavedContactId(response.data.contact.id);
        }
      } else {
        throw new Error(response?.error || "Failed to save contact");
      }
    } catch (error: any) {
      console.error("Save error", error);
      setErrorText(error?.message || "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

  const handleClosePanel = () => {
    (window as any).__cv_close?.();
  };

  const careervineUrl = useMemo(() => {
    // Undefined until the env config loads, so the link is inert rather than
    // pointing at "null/..." or a hardcoded production URL.
    if (!webappBaseUrl) return undefined;
    if (savedContactId) return `${webappBaseUrl}/contacts/${savedContactId}`;
    // For unsaved contacts, encode profile data in URL hash for the preview page
    if (profile) {
      try {
        const dataWithPhoto = photoUrl ? { ...profile, photo_url: photoUrl } : profile;
        const jsonStr = JSON.stringify(dataWithPhoto);
        const bytes = new TextEncoder().encode(jsonStr);
        const binStr = Array.from(bytes, (b: number) => String.fromCharCode(b)).join('');
        const encoded = encodeURIComponent(btoa(binStr));
        return `${webappBaseUrl}/contacts/preview#data=${encoded}`;
      } catch {
        return `${webappBaseUrl}/contacts`;
      }
    }
    return `${webappBaseUrl}/contacts`;
  }, [savedContactId, webappBaseUrl, profile, photoUrl]);

  if (isAuthenticated === null) {
    return (
      <div className="cv-panel">
        <div className="cv-loading">
          <Loader2 className="cv-spinner" />
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="cv-panel">
        <main className="cv-auth">
          <button className="cv-auth-close" onClick={handleClosePanel} aria-label="Close">
            <X size={18} />
          </button>

          <div className="cv-auth-inner">
            <div className="cv-brand-block">
              <div className="cv-brand-badge">
                <Sprout size={30} />
              </div>
              <h1 className="cv-auth-title">Welcome back</h1>
              <p className="cv-auth-subtitle">Sign in to CareerVine</p>
            </div>

            <div className="cv-card">
              <form onSubmit={handleLogin} className="cv-auth-form">
                <div className="cv-field">
                  <Mail className="cv-field-icon" size={18} />
                  <input
                    type="email"
                    className="cv-field-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    autoComplete="email"
                    required
                  />
                </div>

                <div className="cv-field">
                  <Lock className="cv-field-icon" size={18} />
                  <input
                    type={showPassword ? "text" : "password"}
                    className="cv-field-input cv-field-input--trailing"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="cv-field-trailing"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                <div className="cv-forgot-row">
                  <a
                    href={webappBaseUrl ? `${webappBaseUrl}/auth?mode=reset` : undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="cv-link"
                  >
                    Forgot password?
                  </a>
                </div>

                {authError && <div className="cv-error-banner">{authError}</div>}

                <button type="submit" className="cv-btn-primary" disabled={authLoading}>
                  {authLoading && <Loader2 className="cv-btn-spinner" size={18} />}
                  <span>{authLoading ? "Signing in…" : "Sign in"}</span>
                </button>
              </form>
            </div>

            <p className="cv-auth-footer">
              New to CareerVine?{" "}
              <a
                href={webappBaseUrl ? `${webappBaseUrl}/auth?mode=signup` : undefined}
                target="_blank"
                rel="noreferrer"
                className="cv-link cv-link--strong"
              >
                Create an account
              </a>
            </p>
          </div>
        </main>
      </div>
    );
  }

  if (loading) {
    const stageLabels: Record<string, string> = {
      starting: 'Preparing...',
      authenticating: 'Checking auth...',
      scrolling: 'Reading profile...',
      parsing: 'Enriching profile data...',
      done: 'Finishing up...',
      error: 'Something went wrong',
    };
    const stageLabel = analyzing && progressStage
      ? (stageLabels[progressStage] || 'Working...')
      : 'Loading profile...';

    return (
      <div className="cv-panel">
        <div className="cv-loading">
          <Loader2 className="cv-spinner" />
          <span>{stageLabel}</span>
          {analyzing && (
            <div className="cv-progress-bar-container">
              <div
                className="cv-progress-bar"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="cv-panel">
        <header className="cv-header">
          <button className="cv-back-btn" onClick={handleClosePanel}>
            <ArrowLeft className="w-5 h-5" />
          </button>
          <a href={careervineUrl} target="_blank" rel="noreferrer" className="cv-open-link">
            <ExternalLink className="w-4 h-4" />
            {savedContactId ? "View In CareerVine" : "Open CareerVine"}
          </a>
        </header>

        {/* Show existing contact info if found in DB */}
        {existingContact && onProfilePage && (
          <>
            <div className="cv-existing-badge">
              <span className="cv-existing-dot" />
              Already in CareerVine
              <span className="cv-existing-match">
                {existingContact.matchType === 'exact_linkedin' ? 'Exact match' : 'Possible match'}
              </span>
            </div>
            <div className="cv-empty">
              <User className="cv-empty-icon" style={{ color: '#2d6a30' }} />
              <p className="cv-empty-title">{existingContact.name || 'Saved Contact'}</p>
              {existingContact.industry && (
                <p className="cv-empty-subtitle">{existingContact.industry}</p>
              )}
              {existingContact.notes && (
                <p className="cv-empty-subtitle" style={{ marginTop: '8px', fontStyle: 'italic' }}>
                  {existingContact.notes}
                </p>
              )}
              <button className="cv-analyze-btn" onClick={handleRequestScrape} style={{ marginTop: '12px' }}>
                Refresh from LinkedIn
              </button>
            </div>
          </>
        )}

        {/* New contact — not in DB */}
        {!existingContact && (
          <div className="cv-empty">
            {onProfilePage ? (
              aiFailure ? (
                /* AI-availability failure (CAR-26) — specific graceful state */
                <>
                  {aiFailure === "ai_no_key" ? (
                    <Sparkles className="cv-empty-icon cv-ai-notice-icon" />
                  ) : aiFailure === "ai_unavailable" ? (
                    <CloudOff className="cv-empty-icon cv-ai-notice-icon" />
                  ) : aiFailure === "ai_trial_expired" ? (
                    <Hourglass className="cv-empty-icon cv-ai-notice-icon" />
                  ) : (
                    <AlertTriangle className="cv-empty-icon cv-ai-notice-icon" />
                  )}
                  <p className="cv-empty-title">{AI_FAILURE_COPY[aiFailure].title}</p>
                  <p className="cv-empty-subtitle">{AI_FAILURE_COPY[aiFailure].body}</p>
                  <div className="cv-ai-notice-actions">
                    {AI_FAILURE_COPY[aiFailure].retryable && (
                      <button className="cv-analyze-btn" onClick={handleRequestScrape}>
                        Try again
                      </button>
                    )}
                    <a
                      href={webappBaseUrl ? `${webappBaseUrl}/settings?tab=ai` : undefined}
                      target="_blank"
                      rel="noreferrer"
                      className={AI_FAILURE_COPY[aiFailure].retryable ? "cv-ai-notice-link" : "cv-analyze-btn"}
                    >
                      {AI_FAILURE_COPY[aiFailure].ctaLabel}
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="cv-empty-title">Ready to analyze</p>
                  <p className="cv-empty-subtitle">Click below to scrape this LinkedIn profile.</p>
                  {errorText && <p className="cv-empty-error">{errorText}</p>}
                  <button className="cv-analyze-btn" onClick={handleRequestScrape}>
                    {errorText ? "Try again" : "Analyze Profile"}
                  </button>
                </>
              )
            ) : (
              <>
                <MapPin className="cv-empty-icon" />
                <p className="cv-empty-title">No profile detected</p>
                <p className="cv-empty-subtitle">Navigate to a LinkedIn profile page to find and save new contacts.</p>
              </>
            )}
          </div>
        )}

        {/* Auto-scrape toggle — only show on profile pages */}
        {onProfilePage && (
          <div className="cv-autoscrape-toggle">
            <label className="cv-toggle-label">
              <span>Auto-analyze on navigation</span>
              <button
                type="button"
                className={`cv-toggle-switch ${autoScrape ? 'cv-toggle-on' : ''}`}
                onClick={() => handleToggleAutoScrape(!autoScrape)}
                role="switch"
                aria-checked={autoScrape}
              >
                <span className="cv-toggle-knob" />
              </button>
            </label>
          </div>
        )}
      </div>
    );
  }

  const profileName = profile.name || `${profile.first_name} ${profile.last_name}`.trim() || "Profile Name";

  const handleEditClick = () => {
    setIsEditing(true);
    setEditedProfile(JSON.parse(JSON.stringify(profile))); // Deep copy
  };

  const handleEditChange = (field: string, value: any) => {
    if (!editedProfile) return;
    
    setEditedProfile(prev => {
      if (!prev) return null;
      
      // Handle array fields (experience, education)
      if (field.includes('.')) {
        const parts = field.split('.');
        const [arrayName, indexStr, subField] = parts;
        const index = parseInt(indexStr);
        
        if (arrayName === 'experience' && prev.experience) {
          const newExperience = [...prev.experience];
          newExperience[index] = {
            ...newExperience[index],
            [subField]: value
          };
          return {
            ...prev,
            experience: newExperience
          };
        }
        
        if (arrayName === 'education' && prev.education) {
          const newEducation = [...prev.education];
          newEducation[index] = {
            ...newEducation[index],
            [subField]: value
          };
          return {
            ...prev,
            education: newEducation
          };
        }
        
        // Handle nested location fields
        if (parts[0] === 'location' && prev.location) {
          return {
            ...prev,
            location: {
              ...prev.location,
              [parts[1]]: value
            }
          };
        }
      }
      
      // Handle simple fields
      return {
        ...prev,
        [field]: value
      };
    });
  };

  const handleSaveEdit = () => {
    if (editedProfile) {
      setProfile(editedProfile);
      setIsEditing(false);
      setStatusText("Edits applied");
      setTimeout(() => setStatusText(null), 3000);

      // Persist edits into the per-profile cache — otherwise navigating away
      // and back within the cache TTL silently restores the original scrape.
      const match = window.location.href.match(/linkedin\.com\/in\/([^/?]+)/);
      const profileId = match?.[1];
      if (profileId) {
        chrome?.storage?.local?.get?.(['profileCache'], (result: any) => {
          const cache = result?.profileCache || {};
          cache[profileId] = {
            data: editedProfile,
            photoUrl: cache[profileId]?.photoUrl ?? photoUrl ?? null,
            timestamp: Date.now(),
          };
          chrome?.storage?.local?.set?.({ profileCache: cache });
        });
      }
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedProfile(null);
  };

  const handleAddExperience = () => {
    setEditedProfile(prev => prev ? {
      ...prev,
      experience: [...prev.experience, {
        id: `new-exp-${Date.now()}`,
        company: "",
        title: "",
        location: "",
        start_month: "",
        end_month: "",
        is_current: false,
      }]
    } : prev);
  };

  const handleRemoveExperience = (index: number) => {
    setEditedProfile(prev => prev ? {
      ...prev,
      experience: prev.experience.filter((_, i) => i !== index)
    } : prev);
  };

  const handleAddEducation = () => {
    setEditedProfile(prev => prev ? {
      ...prev,
      education: [...prev.education, {
        id: `new-edu-${Date.now()}`,
        school: "",
        degree: "",
        field_of_study: "",
        start_year: "",
        end_year: "",
      }]
    } : prev);
  };

  const handleRemoveEducation = (index: number) => {
    setEditedProfile(prev => prev ? {
      ...prev,
      education: prev.education.filter((_, i) => i !== index)
    } : prev);
  };

  // Update a single field on profile without entering edit mode
  const setProfileField = <K extends keyof ProfileData>(field: K, value: ProfileData[K]) => {
    setProfile(prev => prev ? { ...prev, [field]: value } : prev);
  };

  if (isEditing && editedProfile) {
    return <EditPanel
            profile={editedProfile}
            onChange={handleEditChange}
            onSave={handleSaveEdit}
            onCancel={handleCancelEdit}
            onAddExperience={handleAddExperience}
            onRemoveExperience={handleRemoveExperience}
            onAddEducation={handleAddEducation}
            onRemoveEducation={handleRemoveEducation}
          />;
  }

  return (
    <div className="cv-panel">
      {/* Header */}
      <header className="cv-header">
        <button className="cv-back-btn" onClick={handleClosePanel}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <a href={careervineUrl} target="_blank" rel="noreferrer" className="cv-open-link">
          <ExternalLink className="w-4 h-4" />
          {savedContactId ? "View In CareerVine" : "Open CareerVine"}
        </a>
      </header>

      {/* Existing contact badge */}
      {existingContact && (
        <div className="cv-existing-badge">
          <span className="cv-existing-dot" />
          Already in CareerVine
          {existingContact.matchType === 'exact_linkedin' && (
            <span className="cv-existing-match">Exact match</span>
          )}
        </div>
      )}

      {/* Main Content */}
      <main className="cv-main">
        {/* Existing contact notes — show stored bio instead of regenerating */}
        {existingContact?.notes && (
          <section className="cv-existing-notes">
            <p className="cv-existing-notes-label">Existing notes</p>
            <p className="cv-existing-notes-text">{existingContact.notes}</p>
          </section>
        )}

        {/* Profile Section */}
        <section className="cv-profile-section">
          <div className={`cv-avatar${!photoUrl || photoError ? ' cv-avatar-fallback' : ''}`}>
            {photoUrl && !photoError ? (
              <img
                src={photoUrl}
                alt={profileName}
                className="cv-avatar-img"
                onError={() => setPhotoError(true)}
              />
            ) : (
              <User className="w-8 h-8 text-green-700" />
            )}
          </div>
          <div className="cv-profile-info">
            <h1 className="cv-profile-name">{profileName}</h1>
            <p className="cv-profile-industry">{profile.industry || "Industry"}</p>
          </div>
        </section>

        {/* Contact Status Toggle */}
        <StatusToggle
          value={profile.contact_status}
          onChange={(status) => setProfileField('contact_status', status)}
        />

        {/* Quick Info */}
        <div className="cv-quick-info">
          {(() => {
            const locationStr = [profile.location.city, profile.location.state, profile.location.country].filter(Boolean).join(", ");
            const standardized = standardizeLocation(locationStr);
            return standardized ? (
              <div className="cv-info-row">
                <MapPin />
                <span>{standardized}</span>
              </div>
            ) : null;
          })()}
          <div className="cv-info-row">
            <Mail />
            <InlineInput
              value={profile.email || ""}
              onChange={(v) => setProfileField('email', v)}
              placeholder="Email address"
              className="cv-inline-meta"
            />
          </div>
          <div className="cv-info-row">
            <Clock />
            <SimpleDropdown
              value={profile.follow_up_frequency || ""}
              onChange={(value) => setProfileField('follow_up_frequency', value)}
              options={FOLLOW_UP_OPTIONS}
              placeholder="Follow-up frequency"
              className="cv-view-followup"
            />
          </div>
          {profile.generated_notes && (
            <div className="cv-info-row cv-notes-row">
              <FileText />
              <span>{profile.generated_notes}</span>
            </div>
          )}
        </div>

        {/* Experience Section */}
        {profile.experience.length > 0 && (
        <section className="cv-section">
          <div className="cv-section-header">
            <Briefcase className="w-5 h-5" />
            <h2>Experience</h2>
          </div>
          <div className="cv-experience-list">
            {(() => {
              // Group experiences by company
              const groups: { company: string; roles: typeof profile.experience }[] = [];
              profile.experience.forEach((exp) => {
                const lastGroup = groups[groups.length - 1];
                if (lastGroup && lastGroup.company.toLowerCase() === (exp.company || "").toLowerCase()) {
                  lastGroup.roles.push(exp);
                } else {
                  groups.push({ company: exp.company || "", roles: [exp] });
                }
              });

              return groups.map((group, groupIndex) => {
                const isMultiRole = group.roles.length > 1;

                if (isMultiRole) {
                  // Multi-role at same company - show company header with connected roles
                  return (
                    <div key={groupIndex} className="cv-company-group">
                      <p className="cv-company-header">{group.company}</p>
                      {group.roles[group.roles.length - 1].start_month && (
                        <p className="cv-company-dates">
                          {formatDateRange(group.roles[group.roles.length - 1].start_month, group.roles[0].end_month)}
                        </p>
                      )}
                      {group.roles[0].location && <p className="cv-company-location">{standardizeLocation(group.roles[0].location)}</p>}
                      <div className="cv-roles-timeline">
                        {group.roles.map((exp, roleIndex) => {
                          const dateRange = formatDateRange(exp.start_month, exp.end_month);
                          const isLast = roleIndex === group.roles.length - 1;

                          return (
                            <div key={exp.id} className={`cv-role-item ${isLast ? 'cv-role-last' : ''}`}>
                              <div className="cv-role-dot" />
                              {!isLast && <div className="cv-role-line" />}
                              <div className="cv-role-content">
                                <p className="cv-role-title">{exp.title || "Job Title"}</p>
                                {dateRange && <p className="cv-role-date">{dateRange}</p>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                } else {
                  // Single role at company - simple display
                  const exp = group.roles[0];
                  const dateRange = formatDateRange(exp.start_month, exp.end_month);

                  return (
                    <div key={exp.id} className="cv-job-item">
                      <p className="cv-job-title">{exp.title || "Job Title"}</p>
                      <p className="cv-job-company">{exp.company || "Company"}</p>
                      {dateRange && <p className="cv-job-date">{dateRange}</p>}
                      {exp.location && <p className="cv-job-location">{standardizeLocation(exp.location)}</p>}
                    </div>
                  );
                }
              });
            })()}
          </div>
        </section>
        )}

        {/* Education Section */}
        {profile.education.length > 0 && (
        <section className="cv-section cv-education-section">
          <div className="cv-section-header">
            <GraduationCap className="w-5 h-5" />
            <h2>Education</h2>
          </div>
          <div className="cv-education-list">
            {(() => {
              // Deduplicate education entries - keep entries with most data for each school
              const seen = new Map<string, typeof profile.education[0]>();
              profile.education.forEach((edu) => {
                const key = edu.school.toLowerCase().trim();
                const existing = seen.get(key);
                if (!existing) {
                  seen.set(key, edu);
                } else {
                  // Keep the one with more data
                  const existingScore = (existing.degree ? 1 : 0) + (existing.field_of_study ? 1 : 0) + (existing.start_year ? 1 : 0);
                  const newScore = (edu.degree ? 1 : 0) + (edu.field_of_study ? 1 : 0) + (edu.start_year ? 1 : 0);
                  if (newScore > existingScore) {
                    seen.set(key, edu);
                  }
                }
              });

              return Array.from(seen.values()).map((edu) => {
                const dateRange = formatEducationDateRange(edu.start_year, edu.end_year);

                return (
                  <div key={edu.id} className="cv-edu-item">
                    <p className="cv-edu-school">{edu.school || "School Name"}</p>
                    {(edu.degree || edu.field_of_study) && (
                      <p className="cv-edu-degree">
                        {edu.degree}{edu.degree && edu.field_of_study ? ` · ${edu.field_of_study}` : edu.field_of_study}
                      </p>
                    )}
                    {dateRange && <p className="cv-edu-date">{dateRange}</p>}
                  </div>
                );
              });
            })()}
          </div>
        </section>
        )}
      </main>

      {/* Auto-scrape toggle + Re-analyze */}
      <div className="cv-autoscrape-toggle">
        <label className="cv-toggle-label">
          <span>Auto-analyze on navigation</span>
          <button
            type="button"
            className={`cv-toggle-switch ${autoScrape ? 'cv-toggle-on' : ''}`}
            onClick={() => handleToggleAutoScrape(!autoScrape)}
            role="switch"
            aria-checked={autoScrape}
          >
            <span className="cv-toggle-knob" />
          </button>
        </label>
        <button className="cv-reanalyze-btn" onClick={handleRequestScrape}>
          Re-analyze Profile
        </button>
      </div>

      {/* Footer */}
      <footer className="cv-footer">
        <button
          className="cv-save-btn"
          onClick={handleSaveContact}
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Contact"
          )}
        </button>
        <button className="cv-edit-btn" onClick={handleEditClick}>
          <Pencil className="w-5 h-5" />
        </button>
      </footer>

      {/* Status Messages */}
      {statusText && <div className="cv-status cv-status-success">{statusText}</div>}
      {errorText && <div className="cv-status cv-status-error">{errorText}</div>}
    </div>
  );
};

export default App;
