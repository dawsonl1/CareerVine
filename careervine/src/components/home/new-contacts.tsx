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
      <h3 className="text-xl font-medium text-foreground mb-4">
        New Contacts{" "}
        <span className="text-muted-foreground font-normal">({contacts.length})</span>
      </h3>
      <div className="space-y-1">
        {contacts.map((contact) => {
          const hasEmail = contact.emails.length > 0;
          return (
            <div
              key={contact.id}
              className="flex items-center gap-3 rounded-lg px-4 py-3 hover:bg-surface-container-low transition-colors"
            >
              <ContactAvatar
                name={contact.name}
                photoUrl={contact.photo_url}
                className="w-10 h-10 text-sm shrink-0"
              />
              <span className="text-base text-foreground truncate flex-1 min-w-0">
                {contact.name}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onLog(contact.id)}
                  className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                  title="Log interaction"
                >
                  <MessageSquare className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNote(contact.id)}
                  className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                  title="Add note"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                {hasEmail && (
                  <button
                    type="button"
                    onClick={() => onIntro(contact.id, contact.emails[0])}
                    className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                    title="Send intro message"
                  >
                    <Mail className="h-4 w-4" />
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
