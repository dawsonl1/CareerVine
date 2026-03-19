import { describe, it, expect } from 'vitest';

// Import the shared function from the chrome extension via @ext alias
// @ts-expect-error — plain JS module, no type declarations
import { identifySections } from '@ext/content/identify-sections';

// Helper to build a fake LinkedIn profile text as an array of lines
function buildLines(...sectionDefs: { name: string; content: string[] }[]): string[] {
  const lines: string[] = [];
  for (const sec of sectionDefs) {
    lines.push(sec.name);
    lines.push(...sec.content);
  }
  return lines;
}

describe('identifySections', () => {
  describe('header-only profiles', () => {
    it('returns header spanning all lines when no sections found', () => {
      const lines = ['John Smith', 'Software Engineer', 'San Francisco'];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 3 });
      expect(result.about).toBeNull();
      expect(result.experience).toBeNull();
      expect(result.education).toBeNull();
    });

    it('handles empty lines array', () => {
      const result = identifySections([]);
      expect(result.header).toEqual({ start: 0, end: 0 });
    });

    it('handles single line', () => {
      const result = identifySections(['John Smith']);
      expect(result.header).toEqual({ start: 0, end: 1 });
    });
  });

  describe('standard full profile', () => {
    const lines = [
      'John Smith',           // 0 - header
      'Software Engineer',    // 1
      'San Francisco, CA',    // 2
      'About',                // 3 - about
      'I am a developer.',    // 4
      'I love coding.',       // 5
      'Experience',           // 6 - experience
      'Acme Corp',            // 7
      'Senior Engineer',      // 8
      'Jan 2020 - Present',   // 9
      'Education',            // 10 - education
      'MIT',                  // 11
      'BS Computer Science',  // 12
      '2016 - 2020',          // 13
    ];

    it('identifies header section', () => {
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 3 });
    });

    it('identifies about section', () => {
      const result = identifySections(lines);
      expect(result.about).toEqual({ start: 3, end: 6 });
    });

    it('identifies experience section', () => {
      const result = identifySections(lines);
      expect(result.experience).toEqual({ start: 6, end: 10 });
    });

    it('identifies education section (extends to end)', () => {
      const result = identifySections(lines);
      expect(result.education).toEqual({ start: 10, end: 14 });
    });

    it('leaves skipped sections as null', () => {
      const result = identifySections(lines);
      expect(result.highlights).toBeNull();
      expect(result.services).toBeNull();
      expect(result.featured).toBeNull();
      expect(result.activity).toBeNull();
    });
  });

  describe('Skills/Recommendations as terminator', () => {
    it('stops at Skills section', () => {
      const lines = [
        'Jane Doe',          // 0
        'Designer',          // 1
        'Experience',        // 2
        'Google',            // 3
        'UX Designer',       // 4
        'Skills',            // 5
        'Figma',             // 6
        'Sketch',            // 7
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 2 });
      expect(result.experience).toEqual({ start: 2, end: 5 });
      expect(result.education).toBeNull();
    });

    it('stops at Recommendations section', () => {
      const lines = [
        'Jane Doe',            // 0
        'Education',           // 1
        'Stanford',            // 2
        'Recommendations',     // 3
        'Great colleague!',    // 4
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 1 });
      expect(result.education).toEqual({ start: 1, end: 3 });
    });
  });

  describe('all sections present', () => {
    const lines = [
      'John Smith',        // 0 - header
      'Engineer',          // 1
      'Highlights',        // 2
      'Top voice',         // 3
      'About',             // 4
      'Bio text',          // 5
      'Services',          // 6
      'Consulting',        // 7
      'Featured',          // 8
      'Article title',     // 9
      'Activity',          // 10
      'Posted something',  // 11
      'Experience',        // 12
      'Acme Corp',         // 13
      'Education',         // 14
      'MIT',               // 15
    ];

    it('identifies all sections with correct boundaries', () => {
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 2 });
      expect(result.highlights).toEqual({ start: 2, end: 4 });
      expect(result.about).toEqual({ start: 4, end: 6 });
      expect(result.services).toEqual({ start: 6, end: 8 });
      expect(result.featured).toEqual({ start: 8, end: 10 });
      expect(result.activity).toEqual({ start: 10, end: 12 });
      expect(result.experience).toEqual({ start: 12, end: 14 });
      expect(result.education).toEqual({ start: 14, end: 16 });
    });
  });

  describe('missing middle sections', () => {
    it('handles About directly followed by Education (no Experience)', () => {
      const lines = [
        'John Smith',     // 0
        'About',          // 1
        'Bio',            // 2
        'Education',      // 3
        'MIT',            // 4
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 1 });
      expect(result.about).toEqual({ start: 1, end: 3 });
      expect(result.experience).toBeNull();
      expect(result.education).toEqual({ start: 3, end: 5 });
    });

    it('handles Experience without Education', () => {
      const lines = [
        'John Smith',          // 0
        'Experience',          // 1
        'Acme Corp',           // 2
        'Engineer',            // 3
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 1 });
      expect(result.experience).toEqual({ start: 1, end: 4 });
      expect(result.education).toBeNull();
    });

    it('handles Education without Experience', () => {
      const lines = [
        'John Smith',     // 0
        'Education',      // 1
        'Harvard',        // 2
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 1 });
      expect(result.experience).toBeNull();
      expect(result.education).toEqual({ start: 1, end: 3 });
    });
  });

  describe('section with whitespace in line', () => {
    it('trims lines before matching section headers', () => {
      const lines = [
        'John Smith',
        '  About  ',   // has whitespace
        'Bio text',
        ' Experience ', // has whitespace
        'Acme Corp',
      ];
      const result = identifySections(lines);
      expect(result.about).toEqual({ start: 1, end: 3 });
      expect(result.experience).toEqual({ start: 3, end: 5 });
    });
  });

  describe('header immediately followed by Experience', () => {
    it('handles no About section', () => {
      const lines = [
        'John Smith',     // 0
        'Engineer at Co', // 1
        'Experience',     // 2
        'Company A',      // 3
        'Dev',            // 4
        'Education',      // 5
        'School',         // 6
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 2 });
      expect(result.about).toBeNull();
      expect(result.experience).toEqual({ start: 2, end: 5 });
      expect(result.education).toEqual({ start: 5, end: 7 });
    });
  });

  describe('edge cases', () => {
    it('does not match partial section names', () => {
      const lines = [
        'John Smith',
        'About me paragraph', // contains "About" but isn't exactly "About"
        'Experience level: 5',
        'Education background',
      ];
      const result = identifySections(lines);
      // None of these are exact matches, so header spans everything
      expect(result.header).toEqual({ start: 0, end: 4 });
      expect(result.about).toBeNull();
      expect(result.experience).toBeNull();
      expect(result.education).toBeNull();
    });

    it('handles Activity directly followed by Experience', () => {
      const lines = [
        'Name',         // 0
        'Activity',     // 1
        'Posted stuff', // 2
        'Experience',   // 3
        'Company',      // 4
      ];
      const result = identifySections(lines);
      expect(result.activity).toEqual({ start: 1, end: 3 });
      expect(result.experience).toEqual({ start: 3, end: 5 });
    });

    it('handles profile with only header and Skills', () => {
      const lines = [
        'John Smith',    // 0
        'Engineer',      // 1
        'Skills',        // 2
        'JavaScript',    // 3
      ];
      const result = identifySections(lines);
      expect(result.header).toEqual({ start: 0, end: 2 });
    });

    it('correctly slices content using returned boundaries', () => {
      const lines = [
        'John Smith',        // 0
        'Engineer',          // 1
        'About',             // 2
        'I build things.',   // 3
        'Experience',        // 4
        'Acme - Dev',        // 5
        '2020 - Present',    // 6
      ];
      const result = identifySections(lines);

      // Verify that slicing with these boundaries gives correct content
      const headerContent = lines.slice(result.header.start, result.header.end);
      expect(headerContent).toEqual(['John Smith', 'Engineer']);

      const aboutContent = lines.slice(result.about.start, result.about.end);
      expect(aboutContent).toEqual(['About', 'I build things.']);

      const expContent = lines.slice(result.experience.start, result.experience.end);
      expect(expContent).toEqual(['Experience', 'Acme - Dev', '2020 - Present']);
    });
  });
});
