# CAR-131 — Premium reconnect-to-upgrade

## Problem

Admin Premium switch alone does not request `gmail.modify` on reconnect (auth only *preserves* modify when already granted). Free-connected accounts stay on Outreach; reply detection and bounce stay off.

## Design

1. **`?upgrade=1`** on `/api/gmail/auth` requests `gmail.modify` when `premium_enabled` is on (even if modify not yet granted). Normal reconnects stay sensitive-only.
2. **Capability `inbox:upgrade`**: connected + premium on + no modify. UI shows reconnect CTA.
3. **New free connects** persist `premium_enabled: false` so they do not see the upgrade CTA until an admin turns Premium on.
4. Admin PremiumSection copy points at the reconnect flow.

## Verify

- Auth matrix tests (preserve / upgrade / free / admin-off)
- capabilitiesFor grants `inbox:upgrade` only in the awaiting-scope case
- Manual: admin Premium on for modify-less user → Outreach banner → reconnect → Inbox
