/**
 * M3 Dialog / Modal component
 *
 * Follows Material Design 3 dialog specs:
 *   - Scrim overlay at 32 % opacity
 *   - surface-container-high background
 *   - 28 px corner radius (M3 extra-large shape)
 *   - Headline in on-surface, body in on-surface-variant
 *   - Optional unsaved-changes guard on dismiss
 */

import { ReactNode, useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** When true, dismissing via scrim/Escape/X shows a confirmation dialog */
  hasUnsavedChanges?: boolean;
  /** Custom message for the confirmation dialog */
  confirmMessage?: string;
}

/* ── Inline confirmation dialog ── */
function ConfirmDiscardDialog({
  message,
  onDiscard,
  onKeepEditing,
}: {
  message: string;
  onDiscard: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onKeepEditing} />
      <div className="relative bg-surface-container-high rounded-[28px] shadow-xl max-w-sm w-full p-6">
        <h3 className="text-base font-medium text-foreground mb-2">Unsaved changes</h3>
        <p className="text-sm text-muted-foreground mb-6">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onKeepEditing}
            className="h-10 px-5 rounded-full text-sm font-medium text-primary hover:bg-primary/8 cursor-pointer transition-colors"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-10 px-5 rounded-full text-sm font-medium bg-error text-on-error hover:bg-error/90 cursor-pointer transition-colors"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export { ConfirmDiscardDialog };

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
  hasUnsavedChanges = false,
  confirmMessage = "You have unsaved changes that will be lost.",
}: ModalProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const attemptClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  }, [hasUnsavedChanges, onClose]);

  const confirmDiscard = useCallback(() => {
    setShowConfirm(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirm) {
          setShowConfirm(false);
        } else {
          attemptClose();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, attemptClose, showConfirm]);

  // Reset confirm dialog when modal closes
  useEffect(() => {
    if (!isOpen) setShowConfirm(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const sizeClasses: Record<string, string> = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* M3 Scrim */}
      <div
        className="absolute inset-0 bg-black/32"
        onClick={attemptClose}
      />

      {/* Dialog surface */}
      <div className={`relative w-full ${sizeClasses[size]} bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-hidden flex flex-col`}>
        {/* Headline */}
        {title && (
          <div className="flex items-center justify-between px-6 pt-6 pb-4">
            <h2 className="text-[22px] leading-7 font-normal text-foreground">{title}</h2>
            <button
              onClick={attemptClose}
              className="state-layer p-2 -mr-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>

      {/* Confirm discard dialog */}
      {showConfirm && (
        <ConfirmDiscardDialog
          message={confirmMessage}
          onDiscard={confirmDiscard}
          onKeepEditing={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
