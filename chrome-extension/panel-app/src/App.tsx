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
  Pencil,
} from "lucide-react";

declare const chrome: any;

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
};

const FOLLOW_UP_OPTIONS = [
  "No follow-up",
  "2 weeks",
  "2 months",
  "3 months",
  "6 months",
  "1 year",
];

// Month abbreviations for parsing education end dates
const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Client-side contact status derivation (mirrors backend deriveContactStatus)
// Month-aware: "May 2027" -> student until June 2027; "2027" -> student until July 2027
const deriveContactStatus = (education: Education[], now: Date = new Date()): { contact_status: 'student' | 'professional'; expected_graduation: string | null } => {
  let isStudent = false;
  let latestGradLabel: string | null = null;
  let latestCutoff: Date | null = null;

  for (const edu of education) {
    if (edu.is_current || edu.end_year === "Present") {
      isStudent = true;
      continue;
    }
    if (!edu.end_year) continue;

    const trimmed = edu.end_year.trim();

    // Try month+year: "May 2027"
    const monthYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (monthYearMatch) {
      const mi = MONTH_NAMES[monthYearMatch[1].toLowerCase()];
      const yr = parseInt(monthYearMatch[2]);
      if (mi !== undefined && !isNaN(yr)) {
        const cutoff = new Date(yr, mi + 1, 1);
        if (now < cutoff) {
          isStudent = true;
          if (!latestCutoff || cutoff > latestCutoff) {
            latestCutoff = cutoff;
            latestGradLabel = trimmed;
          }
        }
        continue;
      }
    }

    // Year-only: "2027" -> student until July of that year
    const yearOnly = parseInt(trimmed);
    if (!isNaN(yearOnly) && yearOnly > 1900) {
      const cutoff = new Date(yearOnly, 6, 1); // July 1
      if (now < cutoff) {
        isStudent = true;
        if (!latestCutoff || cutoff > latestCutoff) {
          latestCutoff = cutoff;
          latestGradLabel = trimmed;
        }
      }
    }
  }

  if (isStudent) {
    return { contact_status: 'student', expected_graduation: latestGradLabel };
  }
  return { contact_status: 'professional', expected_graduation: null };
};

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
      country: data.location?.country ?? "United States",
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
  };
};

// Month abbreviations for standardization
const MONTH_ABBREVS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Parse any date format into a Date object
const parseAnyDate = (dateStr: string): Date | null => {
  if (!dateStr || dateStr === "Present") return dateStr === "Present" ? new Date() : null;
  
  // Clean up the string
  const cleaned = dateStr.trim();
  
  // Try "Mon YYYY" format (e.g., "Aug 2024")
  const abbrevMatch = cleaned.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (abbrevMatch) {
    const mi = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === abbrevMatch[1].toLowerCase());
    if (mi !== -1) return new Date(parseInt(abbrevMatch[2]), mi);
  }
  
  // Try "Month YYYY" format (e.g., "August 2024")
  const fullMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (fullMatch) {
    const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === fullMatch[1].toLowerCase());
    if (mi !== -1) return new Date(parseInt(fullMatch[2]), mi);
  }
  
  // Try "Month YY" format with truncated 2-digit year (e.g., "September 24" -> "September 2024")
  // Only match numbers > 12 to avoid confusing day-of-month (e.g., "September 4") with years
  const truncatedMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (truncatedMatch) {
    const num = parseInt(truncatedMatch[2]);
    // Numbers 1-31 are ambiguous (could be day-of-month), so only treat > 31 as definite years
    // Numbers 13-31 are also ambiguous but less likely to be years, so skip them too
    // Only treat 2-digit numbers as truncated years (e.g., 24 -> 2024)
    if (num >= 20 && num <= 99) {
      const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === truncatedMatch[1].toLowerCase());
      const miAbbrev = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === truncatedMatch[1].toLowerCase());
      const monthIndex = mi !== -1 ? mi : miAbbrev;
      if (monthIndex !== -1) {
        const year = num + 2000;
        return new Date(year, monthIndex);
      }
    }
  }
  
  // Try "Mon YYY" format with 3-digit year (e.g., "Dec 202" -> "Dec 2020")
  const threeDigitYear = cleaned.match(/^([A-Za-z]+)\s+(\d{3})$/);
  if (threeDigitYear) {
    const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === threeDigitYear[1].toLowerCase());
    const miAbbrev = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === threeDigitYear[1].toLowerCase());
    const monthIndex = mi !== -1 ? mi : miAbbrev;
    if (monthIndex !== -1) {
      // Assume it's a truncated 4-digit year starting with 202
      const year = parseInt(threeDigitYear[2] + "0");
      return new Date(year, monthIndex);
    }
  }
  
  // Try just year "YYYY"
  const yearMatch = cleaned.match(/^(\d{4})$/);
  if (yearMatch) return new Date(parseInt(yearMatch[1]), 0);
  
  return null;
};

// Standardize a date string to "Mon YYYY" format (e.g., "Aug 2024")
const standardizeMonth = (dateStr: string | null): string => {
  if (!dateStr) return "";
  if (dateStr === "Present") return "Present";
  
  const date = parseAnyDate(dateStr);
  if (!date) return dateStr; // Return original if can't parse
  
  return `${MONTH_ABBREVS[date.getMonth()]} ${date.getFullYear()}`;
};

// Calculate duration between two dates and return formatted string
const calcDuration = (start: string | null, end: string | null): string => {
  if (!start) return "";
  
  const startDate = parseAnyDate(start);
  if (!startDate) return "";
  
  const endDate = end === "Present" ? new Date() : parseAnyDate(end || "");
  if (!endDate) return "";
  
  const totalMonths = (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth());
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  
  if (years > 0 && months > 0) return `${years} yr ${months} mos`;
  if (years > 0) return `${years} yr`;
  if (months > 0) return `${months} mos`;
  return "";
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

// US state abbreviations
const STATE_ABBREVS: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC"
};

// Standardize location to "City, ST, USA" format
const standardizeLocation = (location: string | null): string => {
  if (!location) return "";
  
  // Clean up the string
  const cleaned = location.trim().replace(/\s+/g, ' ');
  
  // If it's a work arrangement, return as-is
  const workArrangementTypes = ['remote', 'on-site', 'onsite', 'hybrid'];
  if (workArrangementTypes.some(type => cleaned.toLowerCase() === type)) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase(); // Capitalize first letter
  }
  
  // If it looks like other job types, return empty (these aren't locations)
  const jobTypes = ['internship', 'contract', 'freelance', 'part-time', 'full-time', 'temporary', 'remote work', 'on site', 'self-employed', 'self employed'];
  if (jobTypes.some(jobType => cleaned.toLowerCase().includes(jobType))) {
    return "";
  }
  
  // Split by comma and clean up
  const parts = location.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return location;
  
  // Try to identify city, state, country
  let city = parts[0];
  let state: string | null = null;
  let country: string | null = parts[parts.length - 1];
  
  if (parts.length >= 3) {
    // Assume: City, State, Country
    state = parts[1];
    country = parts[2];
  } else if (parts.length === 2) {
    // Could be City, State or City, Country
    const secondPart = parts[1].toLowerCase();
    if (STATE_ABBREVS[secondPart] || Object.values(STATE_ABBREVS).includes(parts[1].toUpperCase())) {
      state = parts[1];
      country = "USA";
    } else if (secondPart.includes("united states") || secondPart === "usa" || secondPart === "us") {
      country = "USA";
    } else if (parts[0].length > 2 && parts[1].length <= 2) {
      // Likely City, State (city name longer than state abbreviation)
      state = parts[1];
      country = "USA";
    } else {
      // Assume it's City, Country or just City, State
      state = parts[1];
      country = "USA";
    }
  } else if (parts.length === 1) {
    // Single city name - don't treat it as a country
    city = parts[0];
    state = null;
    country = null;
  }
  
  // Abbreviate state if full name
  const stateLower = state?.toLowerCase();
  if (stateLower && STATE_ABBREVS[stateLower]) {
    state = STATE_ABBREVS[stateLower];
  } else if (state && state.length > 2) {
    // Keep as-is if not a recognized state
  }
  
  // Standardize country
  if (country) {
    const countryLower = country.toLowerCase();
    if (countryLower.includes("united states") || countryLower === "us" || countryLower === "usa") {
      country = "USA";
    }
  }
  
  // Build result
  const result = [city, state, country].filter(Boolean).join(", ");
  return result || location;
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [autoScrape, setAutoScrape] = useState(false);
  const [progressStage, setProgressStage] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [onProfilePage, setOnProfilePage] = useState(
    typeof window !== 'undefined' && window.location?.href?.includes('linkedin.com/in/')
  );
  const [savedContactId, setSavedContactId] = useState<number | null>(null);
  const [webappBaseUrl, setWebappBaseUrl] = useState("https://www.dawsonsprojects.com");
  const [existingContact, setExistingContact] = useState<any>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  
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
    setAuthError(null);
    
    try {
      const response = await chrome?.runtime?.sendMessage?.({
        action: "authenticate",
        credentials: { email, password }
      });
      
      if (response?.success) {
        setIsAuthenticated(true);
        setEmail("");
        setPassword("");
        // Load profile after successful login
        loadLatestProfile();
      } else {
        setAuthError(response?.error || "Login failed");
      }
    } catch (error) {
      console.error("Login error", error);
      setAuthError("Login failed. Please try again.");
    }
  };

  const loadLatestProfile = async () => {
    try {
      const response = await chrome?.runtime?.sendMessage?.({
        action: "getLatestProfile",
      });
      const profileData = enrichProfile(response?.profileData ?? null);
      setProfile(profileData);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load profile", error);
      setErrorText("Unable to load profile data. Visit a LinkedIn profile first.");
      setLoading(false);
    }
  };

  // Load auto-scrape setting, photo URL, and webapp base URL
  useEffect(() => {
    chrome?.storage?.local?.get?.(['autoScrapeEnabled', 'latestPhotoUrl'], (result: any) => {
      setAutoScrape(result?.autoScrapeEnabled || false);
      setPhotoUrl(result?.latestPhotoUrl || null);
      setPhotoError(false);
    });
    // Get webapp URL from config (strips /api from apiBaseUrl)
    chrome?.runtime?.sendMessage?.({ action: 'getConfig' }, (response: any) => {
      if (response?.apiBaseUrl) {
        setWebappBaseUrl(response.apiBaseUrl.replace(/\/api$/, ''));
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
    // Check authentication first
    checkAuthentication().then((authenticated) => {
      if (authenticated) {
        loadLatestProfile();
      }
    });

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
    };

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes.latestProfile) {
        const newProfile = enrichProfile(changes.latestProfile.newValue);
        if (newProfile) {
          setProfile(newProfile);
          setLoading(false);
          // DB match check is handled by content.js checkProfileInDB — no duplicate call needed
        }
      }
      if (area === "local" && changes.latestPhotoUrl) {
        setPhotoUrl(changes.latestPhotoUrl.newValue || null);
        setPhotoError(false);
      }
    };

    const handleAnalyzing = (event: CustomEvent) => {
      setAnalyzing(event.detail.analyzing);
      if (event.detail.analyzing) {
        setLoading(true);
        setProfile(null);
        setStatusText(null);
        setErrorText(null);
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

    const bus = (window as any).__cv_bus;
    chrome?.storage?.onChanged?.addListener(handleStorageChange);
    bus?.addEventListener('analyzing', handleAnalyzing as EventListener);
    bus?.addEventListener('progress', handleProgress as EventListener);
    bus?.addEventListener('newprofile', handleNewProfile as EventListener);
    bus?.addEventListener('leftprofile', handleLeftProfile as EventListener);
    bus?.addEventListener('cachedhit', handleCacheHit as EventListener);
    bus?.addEventListener('dbmatch', handleDBMatch as EventListener);
    bus?.addEventListener('dbnomatch', handleDBNoMatch as EventListener);

    return () => {
      chrome?.storage?.onChanged?.removeListener(handleStorageChange);
      bus?.removeEventListener('analyzing', handleAnalyzing as EventListener);
      bus?.removeEventListener('progress', handleProgress as EventListener);
      bus?.removeEventListener('newprofile', handleNewProfile as EventListener);
      bus?.removeEventListener('leftprofile', handleLeftProfile as EventListener);
      bus?.removeEventListener('cachedhit', handleCacheHit as EventListener);
      bus?.removeEventListener('dbmatch', handleDBMatch as EventListener);
      bus?.removeEventListener('dbnomatch', handleDBNoMatch as EventListener);
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

  const careervineUrl = (() => {
    if (savedContactId) return `${webappBaseUrl}/contacts/${savedContactId}`;
    // For unsaved contacts, encode profile data in URL hash for the preview page
    if (profile) {
      try {
        const jsonStr = JSON.stringify(profile);
        const bytes = new TextEncoder().encode(jsonStr);
        const binStr = Array.from(bytes, (b: number) => String.fromCharCode(b)).join('');
        const encoded = encodeURIComponent(btoa(binStr));
        return `${webappBaseUrl}/contacts/preview#data=${encoded}`;
      } catch {
        return `${webappBaseUrl}/contacts`;
      }
    }
    return `${webappBaseUrl}/contacts`;
  })();

  if (isAuthenticated === null) {
    return (
      <div className="cv-panel">
        <div className="cv-loading">
          <div className="cv-loading-spinner"></div>
          <p>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="cv-panel">
        <header className="cv-header">
          <h2 className="cv-header-title">Sign In</h2>
        </header>
        
        <main className="cv-main">
          <div className="cv-login-container">
            <div className="cv-login-logo">
              <h1 className="cv-login-title">CareerVine</h1>
              <p className="cv-login-subtitle">Sign in to manage your professional network</p>
            </div>
            
            <form onSubmit={handleLogin} className="cv-login-form">
              <div className="cv-form-group">
                <label htmlFor="email" className="cv-form-label">Email</label>
                <input
                  id="email"
                  type="email"
                  className="cv-form-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                />
              </div>
              
              <div className="cv-form-group">
                <label htmlFor="password" className="cv-form-label">Password</label>
                <input
                  id="password"
                  type="password"
                  className="cv-form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="•••••••••"
                  required
                />
              </div>
              
              {authError && (
                <div className="cv-error-message">
                  {authError}
                </div>
              )}
              
              <button type="submit" className="cv-login-btn">
                Sign In
              </button>
            </form>
            
            <div className="cv-login-footer">
              <p className="cv-login-footer-text">
                New to CareerVine? <a href="#" className="cv-login-link">Create an account</a>
              </p>
            </div>
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
              <>
                <p className="cv-empty-title">Ready to analyze</p>
                <p className="cv-empty-subtitle">Click below to scrape this LinkedIn profile.</p>
                <button className="cv-analyze-btn" onClick={handleRequestScrape}>
                  Analyze Profile
                </button>
              </>
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
