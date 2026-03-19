import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration-style tests for the contact import flow.
 * We test the helper functions and data flow with a mock Supabase client.
 * The actual route handler requires Next.js request/response objects,
 * so we test the internal functions that the route calls.
 */

// ── Mock Supabase builder ──

type MockRow = Record<string, any>;

function createMockSupabase(tables: Record<string, MockRow[]> = {}) {
  // Track all operations for assertions
  const ops: { table: string; op: string; data?: any; filters?: any }[] = [];

  function makeQueryBuilder(tableName: string) {
    let filters: Record<string, any> = {};
    let selectFields = '*';

    const builder: any = {
      select(fields?: string) {
        selectFields = fields || '*';
        return builder;
      },
      eq(col: string, val: any) {
        filters[col] = val;
        return builder;
      },
      ilike(col: string, val: string) {
        filters[`${col}__ilike`] = val;
        return builder;
      },
      or(expr: string) {
        filters.__or = expr;
        return builder;
      },
      is(col: string, val: any) {
        filters[`${col}__is`] = val;
        return builder;
      },
      in(col: string, vals: any[]) {
        filters[`${col}__in`] = vals;
        return builder;
      },
      single() {
        const rows = tables[tableName] || [];
        const matching = rows.filter(row => {
          return Object.entries(filters).every(([key, val]) => {
            if (key.includes('__')) return true; // skip complex filters
            return row[key] === val;
          });
        });
        if (matching.length === 0) return { data: null, error: null };
        return { data: matching[0], error: null };
      },
      maybeSingle() {
        return builder.single();
      },
      async then(resolve: any) {
        const rows = tables[tableName] || [];
        resolve({ data: rows, error: null });
      },
    };

    return builder;
  }

  function makeInsertBuilder(tableName: string, data: any) {
    ops.push({ table: tableName, op: 'insert', data });

    // Auto-assign id to inserted rows
    const rows = Array.isArray(data) ? data : [data];
    const inserted = rows.map((row, i) => ({
      id: (tables[tableName]?.length || 0) + i + 1,
      ...row,
    }));

    // Add to the mock table
    if (!tables[tableName]) tables[tableName] = [];
    tables[tableName].push(...inserted);

    const builder: any = {
      select() { return builder; },
      single() {
        return { data: inserted[0], error: null };
      },
    };
    return builder;
  }

  function makeUpdateBuilder(tableName: string, data: any) {
    ops.push({ table: tableName, op: 'update', data });
    const builder: any = {
      eq(col: string, val: any) { return builder; },
      select() { return builder; },
      single() {
        return { data: { id: 1, ...data }, error: null };
      },
    };
    return builder;
  }

  function makeDeleteBuilder(tableName: string) {
    ops.push({ table: tableName, op: 'delete' });
    const builder: any = {
      eq(col: string, val: any) { return builder; },
    };
    return builder;
  }

  const supabase = {
    from(table: string) {
      return {
        select: (fields?: string) => makeQueryBuilder(table).select(fields),
        insert: (data: any) => makeInsertBuilder(table, data),
        update: (data: any) => makeUpdateBuilder(table, data),
        delete: () => makeDeleteBuilder(table),
      };
    },
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null,
      }),
    },
  };

  return { supabase, ops };
}

// ── Import the helpers we're testing ──
import {
  parseFollowUpFrequency,
  sanitizeForPostgrest,
  buildContactData,
  buildUpdateData,
} from '@/lib/import-helpers';

describe('Import flow integration', () => {
  describe('buildContactData produces valid insert payload', () => {
    it('builds complete payload with all fields', () => {
      const profileData = {
        name: 'Jane Doe',
        linkedin_url: 'https://linkedin.com/in/jane-doe',
        industry: 'Finance',
        generated_notes: 'Expert in investment banking',
        contact_status: 'professional',
        expected_graduation: null,
        follow_up_frequency: '3 months',
      };

      const result = buildContactData(profileData, 'user-123', 42);

      expect(result).toEqual({
        user_id: 'user-123',
        name: 'Jane Doe',
        linkedin_url: 'https://linkedin.com/in/jane-doe',
        industry: 'Finance',
        location_id: 42,
        notes: 'Expert in investment banking',
        contact_status: 'professional',
        expected_graduation: null,
        follow_up_frequency_days: 90,
      });
    });

    it('builds minimal payload with defaults', () => {
      const result = buildContactData({}, 'user-456', null);

      expect(result.user_id).toBe('user-456');
      expect(result.name).toBe('Unknown');
      expect(result.linkedin_url).toBeNull();
      expect(result.industry).toBeNull();
      expect(result.location_id).toBeNull();
      expect(result.notes).toContain('Imported from LinkedIn');
      expect(result.contact_status).toBe('professional');
      expect(result.expected_graduation).toBeNull();
      expect(result.follow_up_frequency_days).toBeNull();
    });

    it('uses profileUrl when linkedin_url is missing', () => {
      const result = buildContactData(
        { profileUrl: 'https://linkedin.com/in/test' },
        'user-123',
        null
      );
      expect(result.linkedin_url).toBe('https://linkedin.com/in/test');
    });

    it('prefers linkedin_url over profileUrl', () => {
      const result = buildContactData(
        {
          linkedin_url: 'https://linkedin.com/in/primary',
          profileUrl: 'https://linkedin.com/in/fallback',
        },
        'user-123',
        null
      );
      expect(result.linkedin_url).toBe('https://linkedin.com/in/primary');
    });

    it('prefers follow_up_frequency string over follow_up_frequency_days number', () => {
      const result = buildContactData(
        {
          follow_up_frequency: '6 months',
          follow_up_frequency_days: 30,
        },
        'user-123',
        null
      );
      // parseFollowUpFrequency('6 months') = 180, which takes precedence
      expect(result.follow_up_frequency_days).toBe(180);
    });

    it('falls back to follow_up_frequency_days when frequency string is unrecognized', () => {
      const result = buildContactData(
        {
          follow_up_frequency: 'every day',
          follow_up_frequency_days: 30,
        },
        'user-123',
        null
      );
      // parseFollowUpFrequency('every day') = null, so falls back to 30
      expect(result.follow_up_frequency_days).toBe(30);
    });
  });

  describe('buildUpdateData produces correct partial payload', () => {
    it('includes only provided fields', () => {
      const result = buildUpdateData({ name: 'Updated Name' });
      expect(result).toEqual({ name: 'Updated Name' });
      expect(Object.keys(result)).toHaveLength(1);
    });

    it('maps generated_notes to notes field', () => {
      const result = buildUpdateData({ generated_notes: 'New AI note' });
      expect(result.notes).toBe('New AI note');
      expect(result).not.toHaveProperty('generated_notes');
    });

    it('maps follow_up_frequency string to follow_up_frequency_days', () => {
      const result = buildUpdateData({ follow_up_frequency: '2 weeks' });
      expect(result.follow_up_frequency_days).toBe(14);
      expect(result).not.toHaveProperty('follow_up_frequency');
    });

    it('does not include follow_up_frequency_days for unrecognized strings', () => {
      const result = buildUpdateData({ follow_up_frequency: 'weekly' });
      expect(result).not.toHaveProperty('follow_up_frequency_days');
    });

    it('includes expected_graduation when present', () => {
      const result = buildUpdateData({ expected_graduation: 'May 2027' });
      expect(result.expected_graduation).toBe('May 2027');
    });

    it('uses profileUrl as fallback for linkedin_url', () => {
      const result = buildUpdateData({ profileUrl: 'https://linkedin.com/in/test' });
      expect(result.linkedin_url).toBe('https://linkedin.com/in/test');
    });
  });

  describe('sanitizeForPostgrest prevents filter injection', () => {
    it('strips percent for wildcard injection prevention', () => {
      expect(sanitizeForPostgrest('%admin%')).toBe('admin');
    });

    it('strips underscore for single-char wildcard prevention', () => {
      expect(sanitizeForPostgrest('_dmin')).toBe('dmin');
    });

    it('strips backslash for escape sequence injection', () => {
      expect(sanitizeForPostgrest('test\\value')).toBe('testvalue');
    });

    it('strips dots for operator confusion prevention', () => {
      expect(sanitizeForPostgrest('Dr. Smith')).toBe('Dr Smith');
    });

    it('strips commas for list injection prevention', () => {
      expect(sanitizeForPostgrest('Smith, John')).toBe('Smith John');
    });

    it('strips parentheses for filter injection prevention', () => {
      expect(sanitizeForPostgrest('(admin)')).toBe('admin');
    });

    it('handles combined attack strings', () => {
      expect(sanitizeForPostgrest('%_\\.()')).toBe('');
    });
  });

  describe('mock Supabase client', () => {
    it('tracks insert operations', () => {
      const { supabase, ops } = createMockSupabase();

      supabase.from('contacts').insert({
        name: 'Test Contact',
        user_id: 'user-123',
      }).select().single();

      expect(ops).toHaveLength(1);
      expect(ops[0].table).toBe('contacts');
      expect(ops[0].op).toBe('insert');
      expect(ops[0].data.name).toBe('Test Contact');
    });

    it('returns inserted data with auto-id', () => {
      const { supabase } = createMockSupabase();

      const { data } = supabase.from('contacts').insert({
        name: 'Test',
      }).select().single();

      expect(data.id).toBe(1);
      expect(data.name).toBe('Test');
    });

    it('finds rows by filter', () => {
      const { supabase } = createMockSupabase({
        contacts: [
          { id: 1, name: 'Alice', user_id: 'user-1' },
          { id: 2, name: 'Bob', user_id: 'user-2' },
        ],
      });

      const { data } = supabase.from('contacts').select('*').eq('user_id', 'user-1').single();
      expect(data.name).toBe('Alice');
    });

    it('returns null for no match', () => {
      const { supabase } = createMockSupabase({
        contacts: [{ id: 1, name: 'Alice', user_id: 'user-1' }],
      });

      const { data } = supabase.from('contacts').select('*').eq('user_id', 'user-999').single();
      expect(data).toBeNull();
    });
  });
});
