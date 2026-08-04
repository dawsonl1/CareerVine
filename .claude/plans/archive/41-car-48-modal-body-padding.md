# CAR-48 — Modal body padding baked into the component

## Problem

`Modal` (`careervine/src/components/ui/modal.tsx`) pads its headline row (`px-6 pt-6 pb-4`) but renders body children with **zero padding**. Callers are silently expected to add `px-6 pb-6` themselves — only 2 of 12 call sites do. The other 10 dialogs (unsubscribe-from-bundle, link-LinkedIn, five admin account/security dialogs, add-contact, inject-bundle, person detail) render their copy, inputs, and action buttons flush against the dialog edges. Dawson reported it via the unsubscribe dialog screenshot.

## Fix

Make the padding impossible to forget by moving it into the component:

1. **`modal.tsx`** — body wrapper becomes `px-6 pb-6` (plus `pt-6` when no `title` is rendered, since the headline normally supplies the top spacing — matters for `person-modal`, the one title-less caller).
2. **`contact-edit-modal.tsx`** and **`add-company-modal.tsx`** — drop their now-duplicate `px-6 pb-6` (keep `space-y-4`).

All 12 call sites were read; none relies on edge-to-edge body content, so no other caller changes are needed.

## Verification

- `npm run test` from `careervine/`.
- Browser preview of the unsubscribe dialog (the reported case) — layout restructuring qualifies as high-risk per rule 13.
- Spot-check one previously-correct dialog (Edit contact) to confirm no double padding.
