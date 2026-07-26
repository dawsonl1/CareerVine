import { redirect } from "next/navigation";

/**
 * /interactions — redirects to the Activity page.
 *
 * This route used to render a contact-scoped interactions list that took
 * `contactId` as a PROP. Next never passes props to a page, so visiting the URL
 * left `contactId` undefined, and the component's loader early-returned before
 * clearing `loading` while the effect that would have called it was gated on the
 * same absent id. The result was a live, authenticated route that spun forever
 * (CAR-207).
 *
 * It is a redirect rather than a repaired page because the component had zero
 * importers and both of its jobs already belong to something else: the Activity
 * page (`/meetings`) owns the standalone meetings + interactions timeline with
 * full create/edit/delete, and `components/contacts/contact-timeline-tab.tsx`
 * owns the contact-scoped view it was originally written to be. Rendering "all
 * interactions" here would have built a second surface duplicating Activity.
 *
 * Temporary rather than permanent: a 308 is cached by the browser indefinitely,
 * which is an awkward thing to undo if this URL ever earns a page of its own.
 */
export default function InteractionsRedirectPage() {
  redirect("/meetings");
}
