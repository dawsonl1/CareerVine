# Shared email primitives (CAR-103)

Building blocks imported by BOTH the paid Inbox shell (`../inbox`) and the free
Outreach shell (`../outreach`), so shared work is written once and both tiers
inherit it.

Extraction is demand-driven: CAR-102 moves primitives here as the real Outreach
shell needs them. The compose / send / follow-up stack is already shared via the
global mount in `app/layout.tsx`, so it is not duplicated here.
