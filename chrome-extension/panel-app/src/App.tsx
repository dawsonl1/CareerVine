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
    education: (data.education ?? []).map((edu, index) => ({
      id: (edu as Education)?.id ?? `${Date.now()}-edu-${index}`,
      school: edu.school ?? "",
      degree: edu.degree ?? "",
      field_of_study: edu.field_of_study ?? "",
      start_year: edu.start_year ?? "",
      end_year: edu.end_year ?? "",
    })),
    contact_status: data.contact_status ?? "professional",
    expected_graduation: data.expected_graduation ?? "",
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

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const shadowRoot = (window as any).__cv_sr;
    const root = shadowRoot || document;

    const timer = setTimeout(() => {
      root.addEventListener("mousedown", handler);
    }, 10);

    return () => {
      clearTimeout(timer);
      root.removeEventListener("mousedown", handler);
    };
  }, [isOpen]);

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
      className={`cv-edit-input ${className}`}
      style={{
        minHeight: `${minHeight}px`,
        resize: 'none',
        overflow: 'hidden'
      }}
    />
  );
};


// Edit Panel Component
const EditPanel: React.FC<{
  profile: ProfileData;
  onChange: (field: string, value: any) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ 
  profile, 
  onChange, 
  onSave, 
  onCancel
}) => {
  return (
    <div className="cv-panel">
      {/* Header */}
      <header className="cv-header">
        <button className="cv-back-btn" onClick={onCancel}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="cv-header-title">Edit Profile</h2>
      </header>

      {/* Main Content */}
      <main className="cv-main">
        {/* Profile Section */}
        <section className="cv-profile-section">
          <div className="cv-avatar">
            <User className="w-8 h-8 text-green-700" />
          </div>
          <div className="cv-profile-info">
            <input
              type="text"
              className="cv-edit-name"
              value={profile.name || ""}
              onChange={(e) => onChange('name', e.target.value)}
              placeholder="Profile Name"
            />
          </div>
        </section>

        {/* Quick Info */}
        <section className="cv-quick-info-section">
          <div className="cv-info-row">
            <MapPin className="w-4 h-4 text-gray-400" />
            <div className="cv-location-input-wrapper">
              <input
                type="text"
                className="cv-edit-input cv-edit-location"
                value={profile?.location?.city || ""}
                onChange={(e) => {
                  const value = e.target.value;
                  onChange('location.city', value);
                }}
                placeholder="City name"
              />
            </div>
          </div>
          <div className="cv-info-row">
            <Clock className="w-4 h-4 text-gray-400" />
            <SimpleDropdown
              value={profile.follow_up_frequency || ""}
              onChange={(value) => onChange('follow_up_frequency', value)}
              options={[
                "No follow-up",
                "2 weeks", 
                "2 months",
                "3 months",
                "6 months",
                "1 year"
              ]}
              placeholder="Follow-up frequency"
              className="cv-edit-followup"
            />
          </div>
          <div className="cv-info-row cv-notes-row">
            <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <AutoResizeTextarea
              value={profile.generated_notes || ""}
              onChange={(value) => onChange('generated_notes', value)}
              placeholder="Add notes about this contact..."
              className="cv-edit-notes"
              minHeight={60}
            />
          </div>
        </section>

        {/* Experience Section */}
        <section className="cv-section">
          <div className="cv-section-header">
            <Briefcase className="w-5 h-5" />
            <h2>Experience</h2>
          </div>
          <div className="cv-experience-list">
            {profile.experience.map((exp, index) => (
              <div key={exp.id} className="cv-job-item">
                <input
                  type="text"
                  className="cv-edit-input cv-edit-title"
                  value={exp.title || ""}
                  onChange={(e) => onChange(`experience.${index}.title`, e.target.value)}
                  placeholder="Job Title"
                />
                <input
                  type="text"
                  className="cv-edit-input cv-edit-company"
                  value={exp.company || ""}
                  onChange={(e) => onChange(`experience.${index}.company`, e.target.value)}
                  placeholder="Company"
                />
                <div className="cv-edit-dates">
                  <input
                    type="text"
                    className="cv-edit-input cv-edit-date"
                    value={exp.start_month || ""}
                    onChange={(e) => onChange(`experience.${index}.start_month`, e.target.value)}
                    placeholder="Start (e.g., Aug 2024)"
                  />
                  <span className="cv-edit-date-separator">-</span>
                  <input
                    type="text"
                    className="cv-edit-input cv-edit-date"
                    value={exp.end_month || ""}
                    onChange={(e) => onChange(`experience.${index}.end_month`, e.target.value)}
                    placeholder="End (e.g., Present)"
                  />
                </div>
                <div className="cv-location-input-wrapper">
                  <input
                    type="text"
                    className="cv-edit-input cv-edit-location"
                    value={exp.location || ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      onChange(`experience.${index}.location`, value);
                    }}
                    placeholder="City name"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Education Section */}
        <section className="cv-section cv-education-section">
          <div className="cv-section-header">
            <GraduationCap className="w-5 h-5" />
            <h2>Education</h2>
          </div>
          <div className="cv-education-list">
            {profile.education.map((edu, index) => (
              <div key={edu.id} className="cv-edu-item">
                <input
                  type="text"
                  className="cv-edit-input cv-edit-school"
                  value={edu.school || ""}
                  onChange={(e) => onChange(`education.${index}.school`, e.target.value)}
                  placeholder="School Name"
                />
                <input
                  type="text"
                  className="cv-edit-input cv-edit-degree"
                  value={edu.degree || ""}
                  onChange={(e) => onChange(`education.${index}.degree`, e.target.value)}
                  placeholder="Degree (e.g., Bachelor's, Master's, PhD)"
                />
                <input
                  type="text"
                  className="cv-edit-input cv-edit-field"
                  value={edu.field_of_study || ""}
                  onChange={(e) => onChange(`education.${index}.field_of_study`, e.target.value)}
                  placeholder="Field of Study (e.g., Computer Science, Business)"
                />
                <div className="cv-edit-dates">
                  <input
                    type="text"
                    className="cv-edit-input cv-edit-date"
                    value={edu.start_year || ""}
                    onChange={(e) => onChange(`education.${index}.start_year`, e.target.value)}
                    placeholder="Start Year"
                  />
                  <span className="cv-edit-date-separator">-</span>
                  <input
                    type="text"
                    className="cv-edit-input cv-edit-date"
                    value={edu.end_year || ""}
                    onChange={(e) => onChange(`education.${index}.end_year`, e.target.value)}
                    placeholder="End Year"
                  />
                </div>
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

  // Load auto-scrape setting and webapp base URL
  useEffect(() => {
    chrome?.storage?.local?.get?.(['autoScrapeEnabled'], (result: any) => {
      setAutoScrape(result?.autoScrapeEnabled || false);
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

  // Check if the loaded profile already exists in the user's contacts
  const checkForExistingContact = async (profileData: ProfileData) => {
    try {
      const response = await chrome?.runtime?.sendMessage?.({
        action: "checkDuplicate",
        data: {
          linkedinUrl: profileData.linkedin_url,
          name: profileData.name || `${profileData.first_name} ${profileData.last_name}`.trim()
        }
      });
      if (response?.duplicates?.length > 0) {
        const match = response.duplicates[0];
        setExistingContact(match);
        setSavedContactId(match.id);
      } else {
        setExistingContact(null);
      }
    } catch {
      setExistingContact(null);
    }
  };

  useEffect(() => {
    // Check authentication first
    checkAuthentication().then((authenticated) => {
      if (authenticated) {
        loadLatestProfile();
      }
    });

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes.latestProfile) {
        const newProfile = enrichProfile(changes.latestProfile.newValue);
        if (newProfile) {
          setProfile(newProfile);
          setLoading(false);
          // Check if this contact already exists in the database
          checkForExistingContact(newProfile);
        }
      }
    };

    // Listen for analyzing events from content script
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
        // Profile data arrives via the storage onChanged listener — no need to
        // call loadLatestProfile() here, which would double-process the profile.
        // Just ensure loading is cleared if storage change hasn't fired yet.
        setTimeout(() => {
          setLoading((prev) => prev ? false : prev);
        }, 500);
      }
    };

    // Listen for progress updates
    const handleProgress = (event: CustomEvent) => {
      setProgressStage(event.detail.stage);
      setProgressPercent(event.detail.percent);
    };

    // Listen for new profile navigation — clear old data, show analyze button
    const handleNewProfile = () => {
      setProfile(null);
      setLoading(false);
      setAnalyzing(false);
      setOnProfilePage(true);
      setSavedContactId(null);
      setExistingContact(null);
      setStatusText(null);
      setErrorText(null);
      setProgressStage(null);
      setProgressPercent(0);
    };

    // Listen for cache hit — profile loaded from cache, show it
    const handleCacheHit = (event: CustomEvent) => {
      setOnProfilePage(true);
      setSavedContactId(null);
      setExistingContact(null);
      // Load the cached profile directly from the event — don't rely on storage.onChanged
      const cachedProfile = enrichProfile(event.detail?.profileData ?? null);
      if (cachedProfile) {
        setProfile(cachedProfile);
        setLoading(false);
        checkForExistingContact(cachedProfile);
      } else {
        setLoading(true);
      }
    };

    // Listen for leaving a profile page (timeline, search, etc.)
    const handleLeftProfile = () => {
      setProfile(null);
      setLoading(false);
      setAnalyzing(false);
      setOnProfilePage(false);
      setSavedContactId(null);
      setExistingContact(null);
      setStatusText(null);
      setErrorText(null);
      setProgressStage(null);
      setProgressPercent(0);
    };

    // DB match — contact already exists in CareerVine (no scraping needed)
    const handleDBMatch = (event: CustomEvent) => {
      const contact = event.detail?.contact;
      if (contact) {
        setExistingContact(contact);
        setSavedContactId(contact.id);
        setOnProfilePage(true);
      }
    };

    // DB no match — new contact, show analyze button
    const handleDBNoMatch = () => {
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
      });

      if (response?.success) {
        setStatusText("Contact saved to CareerVine.");
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
      setStatusText("Changes applied — click Save Contact to keep");
      setTimeout(() => setStatusText(null), 5000);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedProfile(null);
  };

  if (isEditing && editedProfile) {
    return <EditPanel
            profile={editedProfile}
            onChange={handleEditChange}
            onSave={handleSaveEdit}
            onCancel={handleCancelEdit}
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
          <div className="cv-avatar">
            <User className="w-8 h-8 text-green-700" />
          </div>
          <div className="cv-profile-info">
            <h1 className="cv-profile-name">{profileName}</h1>
            <p className="cv-profile-industry">{profile.industry || "Industry"}</p>
          </div>
        </section>

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
            <span>{profile.follow_up_frequency || "No follow-up"}</span>
          </div>
          {profile.generated_notes && (
            <div className="cv-info-row cv-notes-row">
              <FileText />
              <span>{profile.generated_notes}</span>
            </div>
          )}
        </div>

        {/* Experience Section */}
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

        {/* Education Section */}
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
