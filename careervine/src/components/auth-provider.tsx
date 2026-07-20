"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { track, identifyNewUser } from "@/lib/analytics/client";
import { hardNavigate } from "@/lib/hard-navigate";
import type { User, Session } from "@supabase/supabase-js";

// Define the shape of our authentication context
// This provides type safety for all auth-related operations and state
type AuthContextType = {
  user: User | null;           // Current authenticated user or null
  session: Session | null;     // Current session or null
  loading: boolean;             // Loading state while checking auth
  signUp: (email: string, password: string, firstName: string, lastName: string) => Promise<{ error?: string; existingAccount?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  resendConfirmation: (email: string) => Promise<{ error?: string }>;
};

// Create the React context with undefined as default
// We throw an error if useAuth is used outside of AuthProvider to catch misuse early
const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * AuthProvider component that wraps the entire app
 * Manages authentication state and provides auth methods to all child components
 * Uses React Context API to avoid prop drilling auth state
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  // State to track the current authenticated user
  const [user, setUser] = useState<User | null>(null);
  // State to track the current session (contains tokens, user, etc.)
  const [session, setSession] = useState<Session | null>(null);
  // Loading state to show spinners while checking authentication
  const [loading, setLoading] = useState(true);

  // Stable Supabase client — created once per mount, not on every render
  const [supabase] = useState(() => createSupabaseBrowserClient());

  // useEffect runs on component mount to check for existing session
  // This handles page refreshes and returning users
  useEffect(() => {
    // Apply a new session with REFERENCE-STABLE state: keep the previous object
    // when identity hasn't changed. On mount Supabase emits the session multiple
    // times in quick succession (getSession, then onAuthStateChange's
    // INITIAL_SESSION, then a token event), each a fresh User/Session object.
    // Without this dedupe, every consumer keyed on `user`/`session` re-runs its
    // effects 2-3×, tripling the data load on every authenticated page (CAR-96).
    const apply = (nextSession: Session | null) => {
      setSession((prev) =>
        prev?.access_token === nextSession?.access_token ? prev : nextSession,
      );
      const nextUser = nextSession?.user ?? null;
      setUser((prev) => (prev?.id === nextUser?.id ? prev : nextUser));
    };

    const getSession = async () => {
      try {
        // Check if there's an existing session in browser storage
        const { data: { session } } = await supabase.auth.getSession();
        apply(session);
      } catch {
        // Stale or invalid refresh token — treat as signed out
        apply(null);
      } finally {
        setLoading(false);
      }
    };

    // Immediately check for existing session. getSession() catches its own
    // failures (falling back to signed-out), so nothing here needs to await it.
    void getSession();

    // Set up a listener for auth state changes (sign in, sign out, token refresh)
    // This keeps our React state in sync with Supabase auth state
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      apply(session);
      setLoading(false);
    });

    // Cleanup: unsubscribe from auth state changes when component unmounts
    // Prevents memory leaks
    return () => subscription.unsubscribe();
  }, [supabase]); // Dependency array ensures this runs once when supabase client is created

  /**
   * Sign up a new user with email/password
   * Creates user in Supabase auth and stores first/last name in user_metadata
   * Returns error message if signup fails
   */
  const signUp = async (email: string, password: string, firstName: string, lastName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Store additional user data in user_metadata
        // This data is automatically available on the user object
        data: {
          first_name: firstName,
          last_name: lastName,
        },
        // The confirmation email's token_hash link lands here, where the
        // session is minted server-side — works cross-tab and cross-device,
        // unlike the PKCE code exchange (CAR-52).
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });

    // Return error message if signup fails, empty object if successful
    if (error) {
      return { error: error.message };
    }

    // With email confirmations enabled, Supabase obfuscates duplicate signups:
    // it returns success with a fake user whose identities array is empty
    // instead of an error. Surface that as "account already exists" so the UI
    // doesn't show a check-your-email screen for an email that never sends.
    if (data.user && data.user.identities?.length === 0) {
      return {
        error: "An account with this email already exists.",
        existingAccount: true,
      };
    }

    // Internal accounts (CAR-80): the signup trigger has already stamped the
    // is_internal app_metadata claim, so skip identifying them and recording
    // the signup — they must stay out of analytics entirely.
    if (data.user?.app_metadata?.is_internal !== true) {
      // Identify first so the signup lands on the real (still-unconfirmed) user
      // rather than the anonymous device id — see identifyNewUser for why.
      if (data.user) identifyNewUser(data.user.id, email);
      track("user_signed_up");
    }
    return {};
  };

  /**
   * Sign in existing user with email/password
   * Supabase automatically handles JWT tokens and session storage
   * Returns error message if signin fails
   */
  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    // Return error message if signin fails, empty object if successful
    if (error) {
      // Suspended accounts are banned in GoTrue; translate its error into a
      // distinct message instead of a generic sign-in failure.
      if (/banned/i.test(error.message)) {
        return {
          error:
            "Your account has been suspended. Contact support if you think this is a mistake.",
        };
      }
      return { error: error.message };
    }

    return {};
  };

  /**
   * Sign out current user
   * Clears session from Supabase and browser storage, then hard-navigates
   * to the landing page so all in-memory state resets. Redirects even if
   * the server revocation call fails — the local session is cleared anyway.
   */
  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Server revocation failed — the local session is cleared regardless.
    }
    hardNavigate("/");
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // Recovery goes through /auth/confirm too: the session is established
      // server-side before /reset-password loads, instead of relying on the
      // hash-token auto-detection race the page used to paper over.
      redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
    });
    if (error) return { error: error.message };
    return {};
  };

  /**
   * Re-send the signup confirmation email. Without this, a user whose link
   * expired would be stranded: sign-in rejects unconfirmed emails and signup
   * rejects the duplicate. Rate limiting is enforced server-side by GoTrue.
   */
  const resendConfirmation = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });
    if (error) return { error: error.message };
    return {};
  };

  // Provide the auth context value to all child components
  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signUp,
        signIn,
        signOut,
        resetPassword,
        resendConfirmation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Custom hook to consume the auth context
 * Provides easy access to auth state and methods in any component
 * Throws error if used outside of AuthProvider (catches misuse early)
 */
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
