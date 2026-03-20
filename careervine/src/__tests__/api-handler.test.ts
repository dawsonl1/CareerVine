import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ── Mocks (no top-level variable references in vi.mock factories) ─────

vi.mock('@/lib/supabase/server-client', () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-123', email: 'test@example.com' } },
        error: null,
      }),
    },
  }),
}));

vi.mock('@/lib/extension-auth', () => ({
  getExtensionAuth: vi.fn().mockResolvedValue({
    user: { id: 'user-123', email: 'test@example.com' },
    supabase: { auth: { getUser: vi.fn() } },
  }),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
}));

import { withApiHandler, ApiError } from '@/lib/api-handler';

// ── Helpers ────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown, searchParams?: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/test');
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      url.searchParams.set(k, v);
    }
  }

  return {
    method,
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(),
    json: body !== undefined ? vi.fn().mockResolvedValue(body) : vi.fn().mockRejectedValue(new Error('No body')),
  } as any;
}

async function callHandler(handler: any, request: any, params?: Record<string, string>) {
  const context = params ? { params: Promise.resolve(params) } : undefined;
  const response = await handler(request, context);
  const data = await response.json();
  return { status: response.status, data };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('withApiHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      const { createSupabaseServerClient } = await import('@/lib/supabase/server-client');
      (createSupabaseServerClient as any).mockResolvedValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { message: 'Not authenticated' },
          }),
        },
      });

      const handler = withApiHandler({
        handler: async () => ({ ok: true }),
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('passes authenticated user to handler', async () => {
      const handler = withApiHandler({
        handler: async ({ user }) => ({ userId: user.id }),
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(200);
      expect(data.userId).toBe('user-123');
    });
  });

  describe('body validation', () => {
    const schema = z.object({
      name: z.string().min(1),
      age: z.number(),
    });

    it('validates and passes body to handler', async () => {
      const handler = withApiHandler({
        schema,
        handler: async ({ body }) => ({ received: body }),
      });

      const { status, data } = await callHandler(
        handler,
        makeRequest('POST', { name: 'Alice', age: 30 }),
      );

      expect(status).toBe(200);
      expect(data.received).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns 400 for invalid body', async () => {
      const handler = withApiHandler({
        schema,
        handler: async () => ({ ok: true }),
      });

      const { status, data } = await callHandler(
        handler,
        makeRequest('POST', { name: '', age: 'not-a-number' }),
      );

      expect(status).toBe(400);
      expect(data.error).toBeDefined();
      expect(typeof data.error).toBe('string');
    });

    it('returns 400 for missing body', async () => {
      const handler = withApiHandler({
        schema,
        handler: async () => ({ ok: true }),
      });

      const { status, data } = await callHandler(handler, makeRequest('POST'));
      expect(status).toBe(400);
      expect(data.error).toBe('Invalid or missing JSON body');
    });
  });

  describe('query validation', () => {
    const querySchema = z.object({
      q: z.string().min(1, 'Search query is required'),
    });

    it('validates and passes query params to handler', async () => {
      const handler = withApiHandler({
        querySchema,
        handler: async ({ query }) => ({ search: query.q }),
      });

      const { status, data } = await callHandler(
        handler,
        makeRequest('GET', undefined, { q: 'alice' }),
      );

      expect(status).toBe(200);
      expect(data.search).toBe('alice');
    });

    it('returns 400 for invalid query params', async () => {
      const handler = withApiHandler({
        querySchema,
        handler: async () => ({ ok: true }),
      });

      const { status, data } = await callHandler(
        handler,
        makeRequest('GET', undefined, { q: '' }),
      );

      expect(status).toBe(400);
      expect(data.error).toContain('Search query is required');
    });
  });

  describe('path params', () => {
    it('passes path params to handler', async () => {
      const handler = withApiHandler({
        handler: async ({ params }) => ({ id: params.messageId }),
      });

      const { status, data } = await callHandler(
        handler,
        makeRequest('GET'),
        { messageId: 'abc123' },
      );

      expect(status).toBe(200);
      expect(data.id).toBe('abc123');
    });
  });

  describe('error handling', () => {
    it('returns ApiError status and message', async () => {
      const handler = withApiHandler({
        handler: async () => {
          throw new ApiError('Not found', 404);
        },
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(404);
      expect(data.error).toBe('Not found');
    });

    it('returns 500 for unexpected errors', async () => {
      const handler = withApiHandler({
        handler: async () => {
          throw new Error('Something broke');
        },
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(500);
      expect(data.error).toBe('An unexpected error occurred');
    });

    it('does not leak error details in response', async () => {
      const handler = withApiHandler({
        handler: async () => {
          throw new Error('Database password is hunter2');
        },
      });

      const { data } = await callHandler(handler, makeRequest('GET'));
      expect(data.error).not.toContain('hunter2');
      expect(data.error).not.toContain('Database');
    });
  });

  describe('response handling', () => {
    it('wraps plain objects in JSON response', async () => {
      const handler = withApiHandler({
        handler: async () => ({ items: [1, 2, 3] }),
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(200);
      expect(data.items).toEqual([1, 2, 3]);
    });

    it('passes through NextResponse directly', async () => {
      const { NextResponse } = await import('next/server');

      const handler = withApiHandler({
        handler: async () => NextResponse.redirect('http://example.com'),
      });

      const response = await handler(makeRequest('GET'));
      // Redirect responses have status 307
      expect(response.status).toBe(307);
    });
  });

  describe('CORS', () => {
    it('includes CORS headers when cors option is set', async () => {
      const handler = withApiHandler({
        extensionAuth: true,
        cors: true,
        handler: async () => ({ ok: true }),
      });

      const response = await handler(makeRequest('GET'));
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('authOptional', () => {
    it('passes null user to handler when not authenticated and authOptional is true', async () => {
      const { createSupabaseServerClient } = await import('@/lib/supabase/server-client');
      (createSupabaseServerClient as any).mockResolvedValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { message: 'Not authenticated' },
          }),
        },
      });

      const handler = withApiHandler({
        authOptional: true,
        handler: async ({ user }) => ({ hasUser: !!user }),
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(200);
      expect(data.hasUser).toBe(false);
    });

    it('still passes authenticated user when authOptional is true and user exists', async () => {
      const handler = withApiHandler({
        authOptional: true,
        handler: async ({ user }) => ({ userId: user?.id ?? null }),
      });

      const { status, data } = await callHandler(handler, makeRequest('GET'));
      expect(status).toBe(200);
      expect(data.userId).toBe('user-123');
    });
  });

  describe('GET routes skip body parsing', () => {
    it('does not call request.json() when no schema is provided', async () => {
      const request = makeRequest('GET');

      const handler = withApiHandler({
        handler: async () => ({ ok: true }),
      });

      await callHandler(handler, request);
      expect(request.json).not.toHaveBeenCalled();
    });
  });
});
