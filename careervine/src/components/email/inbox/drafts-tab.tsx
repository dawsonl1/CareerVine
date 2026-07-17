import { FileText, Trash2 } from "lucide-react";
import type { EmailDraft } from "@/lib/types";

interface DraftsTabProps {
  drafts: EmailDraft[];
  onOpenDraft: (draft: EmailDraft) => void;
  onDeleteDraft: (draftId: number) => void;
  formatDate: (dateStr: string) => string;
}

export function DraftsTab({ drafts, onOpenDraft, onDeleteDraft, formatDate }: DraftsTabProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-medium text-foreground">
          Drafts
          {drafts.length > 0 && <span className="ml-2 text-muted-foreground font-normal">({drafts.length})</span>}
        </h2>
      </div>
      {drafts.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-base text-muted-foreground">No drafts.</p>
          <p className="text-sm text-muted-foreground mt-1.5">Emails you start composing but don&apos;t send will be saved here.</p>
        </div>
      ) : (
        <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
          {drafts.map((draft) => (
            <div key={draft.id} className="px-5 py-3.5 hover:bg-surface-container-low/50 transition-colors cursor-pointer" onClick={() => onOpenDraft(draft)}>
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-surface-container flex items-center justify-center shrink-0">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-base font-medium text-foreground truncate">{draft.subject || "(no subject)"}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-container text-muted-foreground shrink-0">Draft</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-1">
                    <span className="text-sm text-muted-foreground truncate">
                      {draft.recipient_email ? `To: ${draft.contact_name || draft.recipient_email}` : "No recipient"}
                    </span>
                    <span className="text-sm text-muted-foreground">·</span>
                    <span className="text-sm text-muted-foreground shrink-0">{formatDate(draft.updated_at)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDeleteDraft(draft.id); }}
                  className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                  title="Delete draft"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
