import { ShieldAlert } from "lucide-react";

/**
 * Shared OAuth verification warning — shown wherever users connect Google services.
 * Google displays a "This app isn't verified" screen during the OAuth flow.
 */
export function OAuthWarning({ variant = "blue" }: { variant?: "blue" | "amber" }) {
  const isAmber = variant === "amber";
  return (
    <div
      className={`flex gap-3 p-3 rounded-xl border ${
        isAmber
          ? "bg-amber-100/60 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800"
          : "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800"
      }`}
    >
      <ShieldAlert
        className={`h-5 w-5 shrink-0 mt-0.5 ${
          isAmber ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400"
        }`}
      />
      <div
        className={`text-xs leading-relaxed ${
          isAmber ? "text-amber-800 dark:text-amber-300" : "text-blue-800 dark:text-blue-300"
        }`}
      >
        <p className="font-medium mb-1">Google will show a warning screen</p>
        <p>
          CareerVine is in the Google verification process. You&apos;ll see a
          &quot;This app isn&apos;t verified&quot; screen. Click{" "}
          <strong>&quot;Advanced&quot;</strong> then{" "}
          <strong>&quot;Go to CareerVine (unsafe)&quot;</strong> to continue.
          Your data is only used within your CareerVine account.
        </p>
      </div>
    </div>
  );
}
