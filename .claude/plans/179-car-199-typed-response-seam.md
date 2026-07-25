# CAR-199 — Restore the typed-response seam on the gmail inbox and drafts routes

Follow-up from CAR-188. **Stacked on `dawson/car-188-021a8f`**, not branched off
`main`: the explicit response types this removes were introduced by that PR
(#179, open), so there is nothing to switch back to on `main` yet. The PR will
target the CAR-188 branch, and GitHub retargets it to `main` when that merges.

## The two erasing steps

Both routes end up with a handler return type that names almost none of the
fields their consumers read. Two independent causes, and fixing only one leaves
the seam broken.

**1. The `Record<string, unknown>` cast** (`inbox/route.ts`)

```ts
type EmbeddedRow = Record<string, unknown> & {
  email_message_contacts?: Array<{ contact_id: number | null }> | null;
  matched_contact_id?: number | null;
};
const emails = withContactIds(emailsRes.data as EmbeddedRow[]);
```

`emailsRes.data` is already a typed row array (CAR-142 put the `Database`
generic on the factories). The cast discards that. `withContactIds` then does
`{ ...rest, contact_ids: [...ids] }`, and the index signature does not survive
spread inference, so the result is a row with `contact_ids` plus whatever the
intersection named, and nothing else.

**2. The narrow callback annotations**

```ts
followUpsRaw.map((f: { recipient_email?: string | null }) => ({ ...f, matched_contact_id }))
```

Spreading `f` carries only the annotated keys. The annotation exists to name one
field being read; it should come from the array element instead.

## Approach

Let the row types flow. Concretely:

- Type `withContactIds` generically over the row rather than casting to an index
  signature, so `{ ...rest, contact_ids }` keeps every column.
- Delete the inline parameter annotations on `followUpsRaw.map`,
  `scheduledEmails.map`, the `emailsNeedingIds` maps/filters, and the drafts
  equivalents. Where a name is genuinely wanted for an enriched row, declare a
  named type for the *result* rather than annotating the *parameter*.
- Keep the runtime output byte-identical. This is a typing change only; the
  wire shape must not move, or the E2E tier and the two consumers shift under
  it. `npm run test` plus the e2e job are the check on that.

## Then the consumers

`use-inbox-data.ts` back to `InferApiResponse<typeof GET>`, and delete the
comment block explaining why it could not be. Check whether
`outreach-shell.tsx`'s `OutreachInboxResponse` (which points at that comment)
can go too.

The success criterion is the consumers compiling against the inferred type with
**no cast and no local response type**. If a cast is needed anywhere to make it
compile, the route fix is not done, because a cast is exactly what CAR-158
closed and what this ticket exists to avoid re-introducing.

## Risk

The wire shape is what the E2E tier and both shells depend on. A route typing
change that silently drops a column from the response would compile and fail
only at runtime, so verification leans on the full suite plus e2e rather than
tsc alone.

## Verify

`npm run test`, `npx tsc --noEmit`, `npm run lint` from `careervine/`, all run
with no `.next` present (rule 48). Plus `npm run build`.
