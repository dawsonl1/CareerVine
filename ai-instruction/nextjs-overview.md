# Next.js Project Overview

This document summarizes how the `fuell-app` project (and most modern Next.js apps) are structured and how they run, so you can quickly reason about changes from the AI side.

## 1. Directory structure

```text
Networking-Helper/
├── fuell-app/               # Next.js application root
│   ├── src/app/             # App Router entry points (route segments)
│   │   ├── layout.tsx       # Root layout (applies HTML/head/body wrappers)
│   │   └── page.tsx         # Default route rendered at '/'
│   ├── src/lib/             # Reusable libraries (e.g., Supabase helpers)
│   ├── public/              # Static assets served as-is (favicons, images)
│   ├── package.json         # Declares dependencies + scripts
│   ├── next.config.ts       # Next.js runtime configuration
│   ├── tsconfig.json        # TypeScript config (paths, strictness, etc.)
│   └── .next/               # Build output (ignored in git)
└── scripts/, supabase/, etc.
```

Because we’re using the App Router (introduced in Next.js 13+), each folder under `src/app/` can contain:

- `page.tsx` – renders for that route segment
- `layout.tsx` – wrappers providing shared UI/state
- `loading.tsx`, `error.tsx`, `not-found.tsx` – optional special files
- Nested folders map directly to nested routes (e.g., `src/app/dashboard/page.tsx` → `/dashboard`).

## 2. Rendering model

Next.js App Router combines **Server Components** (default) and **Client Components**:

- **Server Components** run on the server at request/build time. They can load data securely using server-side credentials and are ideal for most UI.
- **Client Components** opt in with `'use client'` at the top of the file. Use them for stateful logic, browser-only APIs, and event handlers.
- Components can mix: a server component can import client components, but not vice versa.

`page.tsx` files are Server Components by default. If you need client-side interactivity for the whole page, add `'use client'` at the top (but prefer smaller client islands).

## 3. Data fetching

In App Router, you can fetch data directly inside Server Components using `async` functions:

```tsx
// src/app/page.tsx
import { fetchSomething } from "@/lib/api";

export default async function Home() {
  const data = await fetchSomething();
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

Alternatives:

- **Route handlers** (`src/app/api/*/route.ts`) to expose REST APIs – use `NextRequest`/`NextResponse`.
- **Server actions** (experimental) for form submissions.
- **Client-side hooks** (`useEffect`, SWR, React Query) when you need live updates in the browser.


## 4. Styling

This project currently relies on Tailwind-style utility classes (from the default template). You can extend with:

- Tailwind (if installed) or PostCSS/CSS Modules
- Global styles via `src/app/globals.css`
- Component-scoped styles (`*.module.css`)


## 5. Environment variables

Next.js exposes env vars with these rules:
- Variables prefixed with `NEXT_PUBLIC_` are available in both server and browser bundles.
- Server-only secrets (e.g., `SUPABASE_SERVICE_ROLE_KEY`) must **not** use the prefix and can only be accessed in Server Components, route handlers, or `getServerSideProps` (if using Pages Router).

Values live in `.env.local` (for development) and deployment platform env settings for Production. See `ai-instruction/supabase-workflow.md` (if recreated) for Supabase-specific keys.

## 6. Build & runtime scripts
`package.json` scripts inside `fuell-app/`:
- `npm run dev` – starts Next.js in development (hot reload, stack traces)
- `npm run build` – creates production build (`.next/` output)
- `npm run start` – serves the production build
- `npm run lint` – runs ESLint with Next.js rules


## 7. Common extension points

1. **Adding a new page**: create `src/app/<route>/page.tsx` and optionally `layout.tsx` for route-specific wrappers.
2. **Reusable components**: store in `src/components/` (create if missing). Mark as client components if they use state or event handlers.
3. **Shared utilities**: use `src/lib/` for API clients, Supabase setup, helpers.
4. **API routes**: create `src/app/api/<endpoint>/route.ts` with HTTP methods (GET/POST). These run on the server, similar to Express handlers.


## 8. Deployment notes

- During `npm run build`, Next.js pre-renders pages and determines whether they’re static or dynamic based on data fetching.
- App Router pages using async data fetches default to **Server-Side Rendering** (SSR). Add `export const dynamic = "force-static";` to force static generation when data is deterministic.
- Hosted environments (Vercel, Netlify) read env vars from their dashboards; ensure secrets are configured before deployment.

Keep this document updated as the project gains more structure (e.g., if you add a UI library, auth provider, or state manager). It should remain a quick reference for how the Next.js app is wired.
