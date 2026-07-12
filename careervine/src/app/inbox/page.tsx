import { EmailExperience } from "@/components/email/email-experience";

/**
 * /inbox route. Delegates to EmailExperience, which selects the premium Inbox
 * shell or the free Outreach shell from the user's capabilities (CAR-103) and
 * lazy-loads only the chosen one, so each tier's bundle excludes the other's.
 */
export default function InboxPage() {
  return <EmailExperience />;
}
