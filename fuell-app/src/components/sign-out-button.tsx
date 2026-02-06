/**
 * Sign out button component
 * 
 * Simple button component that calls the signOut method from the auth context.
 * When clicked, it:
 * - Calls Supabase's signOut method
 * - Clears the session from browser storage
 * - Triggers auth state change which updates the UI
 * - Redirects user to authentication form
 */

"use client";

import { useAuth } from "./auth-provider";

export default function SignOutButton() {
  // Get signOut method from auth context
  const { signOut, user } = useAuth();

  if (!user) return null;

  return (
    <button
      onClick={signOut}
      className="text-sm text-gray-500 hover:text-gray-700 font-medium"
    >
      Sign out
    </button>
  );
}
