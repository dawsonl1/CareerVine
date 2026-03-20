/**
 * SchoolAutocomplete — university name input with predictive suggestions
 *
 * Contains a hardcoded list of ~100 major US universities.
 * As the user types, matching universities appear in a dropdown.
 * The user can also type a custom school name not in the list.
 *
 * Used in: contact create/edit form (school_name field)
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GraduationCap } from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";

const UNIVERSITIES = [
  "Arizona State University", "Auburn University", "Baylor University",
  "Boston College", "Boston University", "Brigham Young University",
  "Brown University", "California Institute of Technology",
  "Carnegie Mellon University", "Case Western Reserve University",
  "Clemson University", "Colorado State University", "Columbia University",
  "Cornell University", "Dartmouth College", "Drexel University",
  "Duke University", "Emory University", "Florida State University",
  "Fordham University", "George Washington University",
  "Georgetown University", "Georgia Institute of Technology",
  "Harvard University", "Howard University",
  "Indiana University Bloomington", "Iowa State University",
  "Johns Hopkins University", "Lehigh University",
  "Louisiana State University", "Marquette University",
  "Massachusetts Institute of Technology", "Michigan State University",
  "New York University", "North Carolina State University",
  "Northeastern University", "Northwestern University",
  "Ohio State University", "Oregon State University",
  "Penn State University", "Pepperdine University",
  "Princeton University", "Purdue University", "Rice University",
  "Rutgers University", "Santa Clara University",
  "Southern Methodist University", "Stanford University",
  "Syracuse University", "Temple University", "Texas A&M University",
  "Texas Tech University", "Tufts University", "Tulane University",
  "University of Alabama", "University of Arizona",
  "University of California, Berkeley", "University of California, Davis",
  "University of California, Irvine",
  "University of California, Los Angeles",
  "University of California, San Diego",
  "University of California, Santa Barbara",
  "University of Central Florida", "University of Chicago",
  "University of Cincinnati", "University of Colorado Boulder",
  "University of Connecticut", "University of Delaware",
  "University of Denver", "University of Florida",
  "University of Georgia", "University of Houston",
  "University of Illinois Urbana-Champaign", "University of Iowa",
  "University of Kansas", "University of Kentucky",
  "University of Maryland", "University of Massachusetts Amherst",
  "University of Miami", "University of Michigan",
  "University of Minnesota", "University of Mississippi",
  "University of Missouri", "University of Nebraska-Lincoln",
  "University of North Carolina at Chapel Hill",
  "University of Notre Dame", "University of Oklahoma",
  "University of Oregon", "University of Pennsylvania",
  "University of Pittsburgh", "University of Rochester",
  "University of San Diego", "University of San Francisco",
  "University of South Carolina", "University of South Florida",
  "University of Southern California", "University of Tennessee",
  "University of Texas at Austin", "University of Utah",
  "University of Virginia", "University of Washington",
  "University of Wisconsin-Madison", "Vanderbilt University",
  "Villanova University", "Virginia Tech", "Wake Forest University",
  "Washington State University", "Washington University in St. Louis",
  "West Virginia University", "Yale University",
];

interface SchoolAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function SchoolAutocomplete({
  value,
  onChange,
  placeholder = "e.g. Stanford University",
  className,
}: SchoolAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const filtered = query.trim().length >= 2
    ? UNIVERSITIES.filter((u) =>
        u.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 8)
    : [];

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => { if (filtered.length > 0) setOpen(true); }}
          className={className || "w-full h-14 px-4 pr-10 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"}
          placeholder={placeholder}
        />
        <GraduationCap className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 left-0 w-full bg-surface-container-high rounded-[12px] shadow-lg border border-outline-variant overflow-hidden animate-in fade-in-0 zoom-in-95">
          {filtered.map((uni) => (
            <button
              key={uni}
              type="button"
              onClick={() => {
                onChange(uni);
                setQuery(uni);
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer transition-colors"
            >
              {uni}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
