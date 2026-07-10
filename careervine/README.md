This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Background Automations

CareerVine runs background automations through QStash so important outreach tasks keep moving even when the app is not open:

- Scheduled emails are sent on a recurring cron tick.
- Each scheduled-email cron run now reports delivery lag and throughput health so capacity risks are visible before sends fall behind.
- Follow-up sequence steps are processed every 15 minutes.
- Bundle sync jobs fan out on publish with a daily safety-net sweep.

This keeps delivery and data freshness reliable without requiring users to keep a tab open.

## Company Intelligence Workflow

CareerVine company pages now let you maintain office locations directly, even when you do not yet have a contact tied to that office.

- Add new offices from `Companies -> Company -> Manage offices` using city/state/country.
- Keep recruiting notes and location facets accurate before you build out the full contact map.
- Remove stale inferred offices without losing first-person location data captured on contact profiles.

### Find the Right Company Instantly

As your target list grows, the Companies page keeps it navigable with instant search and stackable filters:

- Search as you type across company names, program names, and tier labels — results update instantly, no page reloads.
- Narrow the list by target status (researching through closed), outreach traction, tier, or whether you already know someone inside.
- Filters combine, so "applied companies in Big Tech where I have no contacts yet" is two clicks — and a live count shows how much of your list matches.
- Every filtered view lives in the URL: share it, bookmark it, or click into a company and come back without losing your place.

## A Network That Keeps Itself Fresh

Contact data goes stale the moment you save it — people change jobs, get promoted, and swap email addresses. CareerVine now keeps LinkedIn-linked contacts current automatically:

- **Automatic refresh drip**: every day a batch of your stalest contacts is quietly re-checked against LinkedIn, prioritizing the people you're actively working with. No tab open, no button to press.
- **Change alerts where you plan your day**: a job change, promotion, or work anniversary lands in your Up Next feed as a ready-to-act suggestion — "Sam just started as Senior PM at Adobe, send a congrats" — at exactly the moment reaching out is most natural.
- **One-click refresh and email finding**: on any contact, refresh their profile on demand or search LinkedIn for a verified email when you don't have one (including when the address you had starts bouncing).
- **Fix broken links fast**: when a LinkedIn URL stops working, CareerVine notices and offers a guided search to re-link the right profile.
- **Spend you can see and control**: enrichment runs on a hard monthly budget, with automatic refreshes pausing early so manual actions always have headroom. The Settings → Data & Scraping tab shows month-to-date spend, run health, and the last refresh sweep.

New contacts saved from the browser extension are enriched automatically — photo, real work history, and a verified email in one pass — so a two-second save produces a complete profile.

### Admin Spend Controls

For account managers, the admin dashboard adds per-account switches for all of this: turn paid enrichment or change detection on or off for any account (or every account at once), with each account's month-to-date spend shown right next to its switch.

## Contact Profiles That Feel Personal

Every contact profile now supports a dedicated profile photo upload flow, so users can keep their network visually recognizable at a glance:

- Upload a contact photo directly from the contact profile.
- Replace an existing photo anytime with a fresh image.
- Remove photos to fall back to clean initial-based avatars.

Photos are stored per account and instantly reflected across contact views, helping users scan and recognize relationships faster.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
