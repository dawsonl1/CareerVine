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

    let prospects = 0, bench = 0, nonVanity = 0, withEmail = 0, employmentRows = 0;
    for (const file of files) {
      const record = JSON.parse(readFileSync(file, 'utf8')) as PeopleRecord;
      const p = mapPeopleRecord(record, { batch: 'shakedown' });
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.linkedin_url).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      if (p.network_status === 'prospect') prospects++;
      else bench++;
      if (p.non_vanity_url) nonVanity++;
      if (p.email) withEmail++;
      employmentRows += p.employment.length;
      for (const emp of p.employment) {
        expect(emp.company_name || emp.linkedin_company_id).toBeTruthy();
      }
    }
    // Shakedown ground truth: 40 SELECTED / 40 BENCH, 6 internal-id URLs
    expect(prospects).toBe(40);
    expect(bench).toBe(40);
    expect(nonVanity).toBe(6);
    expect(withEmail).toBeGreaterThan(60);
    expect(employmentRows).toBeGreaterThan(200);
  });
});
