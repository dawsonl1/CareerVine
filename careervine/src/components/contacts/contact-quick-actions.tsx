"use client";

import { Button } from "@/components/ui/button";
import { useCompose } from "@/components/compose-email-context";
import { Send, MessageSquare } from "lucide-react";
import type { Contact } from "@/lib/types";

interface ContactQuickActionsProps {
  contact: Contact;
  onLogConversation: () => void;
}

export function ContactQuickActions({
  contact,
  onLogConversation,
}: ContactQuickActionsProps) {
  const { gmailConnected, openCompose } = useCompose();
  const primaryEmail =
    contact.contact_emails.find((e) => e.is_primary)?.email ||
    contact.contact_emails[0]?.email;

  return (
    <div className="flex flex-wrap gap-2.5">
      <Button variant="tonal" size="sm" onClick={onLogConversation}>
        <MessageSquare className="h-5 w-5" /> Log conversation
      </Button>
      {gmailConnected && primaryEmail && (
        <Button
          variant="tonal"
          size="sm"
          onClick={() => openCompose({ to: primaryEmail, name: contact.name })}
        >
          <Send className="h-5 w-5" /> Compose email
        </Button>
      )}
    </div>
  );
}
