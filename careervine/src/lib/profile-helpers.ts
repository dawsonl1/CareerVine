/**
 * Pure helpers for post-processing parsed LinkedIn profile data.
 * Extracted for testability.
 */

/** Add is_current flag to experience entries based on end_month. */
export function addIsCurrentToExperience(experience: any[]): any[] {
  return experience.map(exp => ({
    ...exp,
    is_current: exp.end_month === "Present"
  }));
}

/** Add is_current flag to education entries based on end_year. */
export function addIsCurrentToEducation(education: any[]): any[] {
  return education.map(edu => ({
    ...edu,
    is_current: edu.end_year === "Present"
  }));
}

/** Derive current_company and current_title from experience list. */
export function deriveCurrentRole(experience: any[]): { current_company: string | null; current_title: string | null } {
  const current = experience.find(exp => exp.is_current);
  return {
    current_company: current?.company || null,
    current_title: current?.title || null,
  };
}

/** Determine contact_status and expected_graduation from education data. */
export function deriveContactStatus(
  education: any[],
  currentYear: number = new Date().getFullYear()
): { contact_status: 'student' | 'professional'; expected_graduation: string | null } {
  const hasCurrentEducation = education.some(edu => edu.is_current);
  const futureGraduation = education.find(edu => {
    const endYear = parseInt(edu.end_year);
    return endYear && endYear > currentYear;
  });

  if (hasCurrentEducation || futureGraduation) {
    return {
      contact_status: 'student',
      expected_graduation: futureGraduation?.end_year || null,
    };
  }

  return {
    contact_status: 'professional',
    expected_graduation: null,
  };
}
