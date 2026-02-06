"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { User, Session } from "@supabase/supabase-js";

// Define the shape of our authentication context
// This provides type safety for all auth-related operations and state
type AuthContextType = {
  user: User | null;           // Current authenticated user or null
  session: Session | null;     // Current session or null
  loading: boolean;             // Loading state while checking auth
  signUp: (email: string, password: string, firstName: string, lastName: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
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
  
  // Create a single Supabase client instance for browser-side operations
  const supabase = createSupabaseBrowserClient();

  // useEffect runs on component mount to check for existing session
  // This handles page refreshes and returning users
  useEffect(() => {
    const getSession = async () => {
      // Check if there's an existing session in browser storage
      const { data: { session } } = await supabase.auth.getSession();
      
      // Update state with session data
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    };

    // Immediately check for existing session
    getSession();

    // Set up a listener for auth state changes (sign in, sign out, token refresh)
    // This keeps our React state in sync with Supabase auth state
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Update React state whenever auth state changes
      setSession(session);
      setUser(session?.user ?? null);
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
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Store additional user data in user_metadata
        // This data is automatically available on the user object
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    });

    // Return error message if signup fails, empty object if successful
    if (error) {
      return { error: error.message };
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
      return { error: error.message };
    }

    return {};
  };

  /**
   * Sign out current user
   * Clears session from Supabase and browser storage
   * Auth state change listener will automatically update React state
   */
  const signOut = async () => {
    await supabase.auth.signOut();
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
