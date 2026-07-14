# CAR-125: Outreach free tier see and edit follow-ups

## Goal

Show every pending/waiting follow-up step on Outreach and allow editing via FollowUpModal. Content-preserving edits keep awaiting_review/expired so Send now still works.

## Approach

1. OutreachShell: list all open steps + Edit → FollowUpModal
2. PUT reconcile: preserve review status when delay unchanged; include expired in open delete set
3. Tests + docs
