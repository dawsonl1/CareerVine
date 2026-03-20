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
    <div className="flex flex-wrap gap-2">
      <Button variant="tonal" size="sm" onClick={onLogConversation}>
        <MessageSquare className="h-4 w-4" /> Log conversation
      </Button>
      {gmailConnected && primaryEmail && (
        <Button
          variant="tonal"
          size="sm"
          onClick={() => openCompose({ to: primaryEmail, name: contact.name })}
        >
          <Send className="h-4 w-4" /> Compose email
        </Button>
      )}
    </div>
  );
}
