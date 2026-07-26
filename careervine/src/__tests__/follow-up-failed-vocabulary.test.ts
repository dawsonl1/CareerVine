import { describe, it, expect } from "vitest";
import {
  FollowUpMessageStatus,
  OPEN_FOLLOW_UP_MESSAGE_STATUSES,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
  ACTIONABLE_FOLLOW_UP_MESSAGE_STATUSES,
  isOpenFollowUpMessage,
  isUnresolvedFollowUpMessage,
  isActionableFollowUpMessage,
} from "@/lib/constants";

/**
 * `failed` must stay out of all three follow-up message vocabularies.
 *
 * This is one assertion guarding a whole safety property, and CAR-207 shipped
 * without it. Adding `failed` to any of the three is the tempting wrong fix for
 * "the user cannot see this state", and each has a distinct, severe failure:
 *
 *   ACTIONABLE  reinstates the exact defect CAR-207 exists to close. The confirm
 *               route derives CONFIRMABLE_STATUSES from it, so the portal would
 *               claim and RE-SEND a message Gmail may already have delivered.
 *   UNRESOLVED  deadlocks the sequence (the completion count never reaches 0) and
 *               loses the record: teardown cascades rewrite unresolved rows to
 *               'cancelled', and the edit route hard-DELETEs them.
 *   OPEN        inflates every "N follow-ups scheduled" count with a message that
 *               will never be sent.
 *
 * The visibility problem is solved by widening the SURFACES that render a
 * terminal record, never by making the record look like a task.
 */
describe("the 'failed' follow-up status stays terminal (CAR-207)", () => {
  const failed: string = FollowUpMessageStatus.Failed;

  it("is absent from all three status vocabularies", () => {
    expect([...OPEN_FOLLOW_UP_MESSAGE_STATUSES]).not.toContain(failed);
    expect([...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]).not.toContain(failed);
    expect([...ACTIONABLE_FOLLOW_UP_MESSAGE_STATUSES]).not.toContain(failed);
  });

  it("is rejected by all three predicates", () => {
    expect(isOpenFollowUpMessage(failed)).toBe(false);
    expect(isUnresolvedFollowUpMessage(failed)).toBe(false);
    expect(isActionableFollowUpMessage(failed)).toBe(false);
  });

  it("still admits the statuses that ARE open, unresolved and actionable", () => {
    // Guards the assertions above against passing vacuously on empty arrays or
    // predicates that were accidentally made to return false for everything.
    expect(isOpenFollowUpMessage(FollowUpMessageStatus.Pending)).toBe(true);
    expect(isUnresolvedFollowUpMessage(FollowUpMessageStatus.Expired)).toBe(true);
    expect(isActionableFollowUpMessage(FollowUpMessageStatus.AwaitingReview)).toBe(true);
  });
});
