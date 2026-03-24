"use client";

import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { MessageSquare, Pencil, Mail } from "lucide-react";

export interface NewContact {
  id: number;
  name: string;
  photo_url: string | null;
  emails: string[];
}

interface NewContactsProps {
  contacts: NewContact[];
  onLog: (contactId: number) => void;
  onNote: (contactId: number) => void;
  onIntro: (contactId: number, email: string) => void;
}

export function NewContacts({ contacts, onLog, onNote, onIntro }: NewContactsProps) {
  if (contacts.length === 0) return null;

  return (
    <div>
      <h3 className="text-lg font-medium text-foreground mb-3">
        New Contacts{" "}
        <span className="text-muted-foreground font-normal">({contacts.length})</span>
      </h3>
      <div className="space-y-1">
        {contacts.map((contact) => {
          const hasEmail = contact.emails.length > 0;
          return (
            <div
              key={contact.id}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-surface-container-low transition-colors"
            >
              <ContactAvatar
                name={contact.name}
                photoUrl={contact.photo_url}
                className="w-8 h-8 text-xs shrink-0"
              />
              <span className="text-sm text-foreground truncate flex-1 min-w-0">
                {contact.name}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onLog(contact.id)}
                  className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                  title="Log interaction"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onNote(contact.id)}
                  className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                  title="Add note"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {hasEmail && (
                  <button
                    type="button"
                    onClick={() => onIntro(contact.id, contact.emails[0])}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                    title="Send intro message"
                  >
                    <Mail className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
