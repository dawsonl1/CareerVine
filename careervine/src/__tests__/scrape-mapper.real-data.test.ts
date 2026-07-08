/**
 * Verification against the real shakedown people/ records on Google Drive.
 * Skipped automatically when the Drive folder isn't mounted (CI, other machines).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mapPeopleRecord, type PeopleRecord } from '@/lib/scrape-mapper';

const PEOPLE_DIR = join(
  process.env.HOME ?? '',
  'Library/CloudStorage/GoogleDrive-dawsonlpitcher@gmail.com/My Drive/PM Recruiting/Target Companies/people',
);

const available = existsSync(PEOPLE_DIR) && statSync(PEOPLE_DIR).isDirectory();

describe.skipIf(!available)('mapPeopleRecord against real shakedown records', () => {
  it('maps every record without throwing and with sane output', () => {
    const files: string[] = [];
    for (const dir of readdirSync(PEOPLE_DIR)) {
      const sub = join(PEOPLE_DIR, dir);
      if (!statSync(sub).isDirectory()) continue;
      for (const f of readdirSync(sub)) {
        if (f.endsWith('.json')) files.push(join(sub, f));
      }
    }
    expect(files.length).toBeGreaterThan(0);

    // The pipeline actively writes new records — assert structural
    // invariants, never exact counts (they change between runs).
    let prospects = 0, bench = 0, withEmail = 0, employmentRows = 0;
    for (const file of files) {
      const record = JSON.parse(readFileSync(file, 'utf8')) as PeopleRecord;
      const p = mapPeopleRecord(record, { batch: 'real-data-check' });
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.linkedin_url).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      expect(['prospect', 'bench']).toContain(p.network_status);
      if (p.network_status === 'prospect') prospects++;
      else bench++;
      if (p.email) withEmail++;
      employmentRows += p.employment.length;
      for (const emp of p.employment) {
        expect(emp.company_name || emp.linkedin_company_id).toBeTruthy();
      }
    }
    expect(prospects).toBeGreaterThan(0);
    expect(bench).toBeGreaterThan(0);
    expect(withEmail).toBeGreaterThan(0);
    expect(employmentRows).toBeGreaterThan(files.length); // avg > 1 job per person
  });
});
