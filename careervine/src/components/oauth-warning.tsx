import { ShieldAlert } from "lucide-react";

/**
 * Shared OAuth verification warning — shown wherever users connect Google services.
 * Google displays a "This app isn't verified" screen during the OAuth flow.
 */
export function OAuthWarning() {
  return (
    <div className="flex gap-3 p-3 rounded-xl border border-outline-variant bg-surface-container">
      <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-tertiary" />
      <div className="text-xs leading-relaxed text-foreground">
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
