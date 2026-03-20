"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { X, Check, AlertTriangle, Info } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "info" | "warning";

type ToastAction = { label: string; onClick: () => void };

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  actions?: ToastAction[];
  showProgress?: boolean;
  duration?: number;
}

interface ToastOptions {
  variant?: ToastVariant;
  duration?: number;
  actions?: ToastAction[];
  showProgress?: boolean;
}

interface ToastContextValue {
  toast: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

// ── Context ────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ── Provider ───────────────────────────────────────────────────────────

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Clear all pending timers on unmount
  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (
      message: string,
      options?: ToastOptions,
    ): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const variant = options?.variant ?? "info";
      const duration = options?.duration ?? DEFAULT_DURATION;

      const newToast: Toast = {
        id,
        message,
        variant,
        actions: options?.actions,
        showProgress: options?.showProgress,
        duration: duration > 0 ? duration : undefined,
      };

      setToasts((prev) => {
        const next = [...prev, newToast];
        return next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
      });

      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismiss],
  );

  const success = useCallback(
    (msg: string) => toast(msg, { variant: "success" }),
    [toast],
  );
  const error = useCallback(
    (msg: string) => toast(msg, { variant: "error", duration: 6000 }),
    [toast],
  );
  const info = useCallback(
    (msg: string) => toast(msg, { variant: "info" }),
    [toast],
  );
  const warning = useCallback(
    (msg: string) => toast(msg, { variant: "warning", duration: 5000 }),
    [toast],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss, success, error, info, warning }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ── Container ──────────────────────────────────────────────────────────

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ── Individual toast ───────────────────────────────────────────────────

const VARIANT_STYLES: Record<
  ToastVariant,
  { bg: string; icon: React.ElementType; iconColor: string }
> = {
  success: {
    bg: "bg-[var(--md-primary)] text-[var(--md-on-primary)]",
    icon: Check,
    iconColor: "text-[var(--md-on-primary)]",
  },
  error: {
    bg: "bg-[var(--md-error)] text-[var(--md-on-error)]",
    icon: AlertTriangle,
    iconColor: "text-[var(--md-on-error)]",
  },
  warning: {
    bg: "bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)]",
    icon: AlertTriangle,
    iconColor: "text-[var(--md-on-tertiary)]",
  },
  info: {
    bg: "bg-[var(--md-on-surface)] text-[var(--md-surface)]",
    icon: Info,
    iconColor: "text-[var(--md-surface)]",
  },
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const { bg, icon: Icon, iconColor } = VARIANT_STYLES[toast.variant];

  return (
    <div
      className={`pointer-events-auto flex flex-col rounded-[var(--md-shape-sm)] shadow-[var(--md-elevation-3)] min-w-[300px] max-w-[420px] animate-slide-in-right overflow-hidden ${bg}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <Icon size={18} className={`shrink-0 ${iconColor}`} />
        <span className="flex-1 text-sm font-medium">{toast.message}</span>
        {toast.actions?.map((action, i) => (
          <button
            key={i}
            onClick={() => {
              action.onClick();
            }}
            className="shrink-0 text-sm font-semibold underline underline-offset-2 opacity-90 hover:opacity-100 transition-opacity"
          >
            {action.label}
          </button>
        ))}
        <button
          onClick={() => onDismiss(toast.id)}
          className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
      {toast.showProgress && toast.duration && (
        <div className="h-[3px] w-full bg-current/10">
          <div
            className="h-full bg-current/40 rounded-full"
            style={{
              animation: `toast-progress ${toast.duration}ms linear forwards`,
            }}
          />
        </div>
      )}
    </div>
  );
}
