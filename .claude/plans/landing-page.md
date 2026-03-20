# Landing Page Redesign (v2)

## Goal
Make the landing page more interactive, impact-focused, and compelling. Shift from a flat feature-list to user-outcome-driven messaging with interactive expandable cards.

## Current State
Landing page exists with: hero, 3 value prop cards, 8 feature sections with bullet lists, CTA, footer. Copy is feature-focused ("Conversation logging", "Transcript parsing"). Layout is a long vertical scroll with all details always visible.

## Key Changes

### 1. Hero — Sharpen copy
- More emotionally resonant headline
- Subtext paints the pain point, then the solution

### 2. Replace flat feature list with interactive expandable card grid
- **Card grid**: 2 columns on desktop, 1 on mobile
- Each card shows: icon + impact-focused headline + short supporting sentence
- Click to expand → reveals feature details with smooth height animation
- Expanding a card pushes siblings down naturally
- Only one card open at a time (accordion) to keep it clean
- Subtle hover lift effect (shadow + slight translateY)
- ChevronDown icon rotates on expand

### 3. Rewrite all copy: impact-first headlines
| Current (feature name) | New (user outcome) |
|---|---|
| Conversation logging | Remember every conversation, word for word |
| Transcript parsing | Turn recordings into searchable notes |
| Action items | Never forget what you promised |
| Relationship health tracking | Know exactly who needs your attention |
| Contact management | Your entire network, organized and searchable |
| Gmail integration | Send smarter emails without leaving the app |
| Google Calendar sync | Your schedule and your network, in sync |
| LinkedIn import | Add anyone from LinkedIn in one click |

Descriptions become short user-impact sentences. Bullet details stay but are hidden until card is expanded.

### 4. Bottom CTA — Warmer, more personal copy

## Technical Approach
- All changes in `landing-page.tsx` — no new files
- React state for expanded card index (`expandedIndex: number | null`)
- CSS `grid-template-rows: 0fr → 1fr` transition for smooth expand
- No external animation libraries

## What stays the same
- Header/nav, auth flow, footer structure
