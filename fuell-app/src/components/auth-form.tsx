/**
 * Authentication form component
 * 
 * This component handles both sign up and sign in functionality in a single form.
 * It includes:
 * - Form validation for required fields
 * - Mode switching between sign up and sign in
 * - Loading states during authentication
 * - Error handling and user feedback
 * - Email/password authentication with Supabase
 * - User metadata storage (first/last name)
 */

"use client";

import { useState } from "react";
import { useAuth } from "./auth-provider";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Mail, Lock, User, Eye, EyeOff } from "lucide-react";

export default function AuthForm() {
  // Get authentication methods from context
  const { signUp, signIn } = useAuth();
  
  // Form mode: 'signin' or 'signup'
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  
  // Form state for all input fields
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    firstName: "",
    lastName: "",
  });
  
  // UI state for loading and error handling
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  /**
   * Handle form submission
   * 
   * Depending on mode, calls either signUp or signIn from auth context.
   * Handles loading states and error display.
   * 
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      // Call appropriate auth method based on current mode
      if (mode === "signup") {
        // Sign up requires all fields including name
        const result = await signUp(
          formData.email,
          formData.password,
          formData.firstName,
          formData.lastName
        );
        if (result.error) {
          setError(result.error);
        }
      } else {
        // Sign in only needs email and password
        const result = await signIn(formData.email, formData.password);
        if (result.error) {
          setError(result.error);
        }
      }
    } catch (err) {
      // Handle unexpected errors
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle input field changes
   * 
   * Updates form state when user types in any field.
   * Uses the input name to determine which field to update.
   * 
   * @param e - Input change event
   */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo and title */}
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-primary rounded-xl flex items-center justify-center mb-4">
            <span className="text-primary-foreground font-bold text-2xl">NH</span>
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            {mode === "signin" ? "Welcome back" : "Create account"}
          </h1>
          <p className="text-muted-foreground">
            {mode === "signin" ? (
              "Sign in to your account to continue"
            ) : (
              "Get started with your professional network"
            )}
          </p>
        </div>

        {/* Auth card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-center space-x-2">
              <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                <User className="h-4 w-4 text-primary" />
              </div>
              <h2 className="text-xl font-semibold text-foreground">
                {mode === "signin" ? "Sign In" : "Sign Up"}
              </h2>
            </div>
          </CardHeader>
          <CardContent>
            {/* Mode toggle */}
            <div className="text-center mb-6">
              <p className="text-sm text-muted-foreground">
                {mode === "signin" ? (
                  <>
                    Don't have an account?{" "}
                    <button
                      type="button"
                      onClick={() => setMode("signup")}
                      className="font-medium text-primary hover:underline"
                    >
                      Sign up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => setMode("signin")}
                      className="font-medium text-primary hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </div>

            {/* Authentication form */}
            <form className="space-y-4" onSubmit={handleSubmit}>
              {/* Error message display */}
              {error && (
                <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              {/* Form fields */}
              <div className="space-y-4">
                {/* Email field */}
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1">
                    Email address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={formData.email}
                      onChange={handleChange}
                      className="w-full pl-10 pr-3 py-2 border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                {/* Password field */}
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={mode === "signin" ? "current-password" : "new-password"}
                      required
                      value={formData.password}
                      onChange={handleChange}
                      className="w-full pl-10 pr-10 py-2 border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="•••••••••"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Name fields - only shown during sign up */}
                {mode === "signup" && (
                  <>
                    <div>
                      <label htmlFor="firstName" className="block text-sm font-medium text-foreground mb-1">
                        First name
                      </label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                          id="firstName"
                          name="firstName"
                          type="text"
                          autoComplete="given-name"
                          required
                          value={formData.firstName}
                          onChange={handleChange}
                          className="w-full pl-10 pr-3 py-2 border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          placeholder="John"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="lastName" className="block text-sm font-medium text-foreground mb-1">
                        Last name
                      </label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                          id="lastName"
                          name="lastName"
                          type="text"
                          autoComplete="family-name"
                          required
                          value={formData.lastName}
                          onChange={handleChange}
                          className="w-full pl-10 pr-3 py-2 border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          placeholder="Doe"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Submit button */}
              <Button type="submit" className="w-full" loading={loading}>
                {loading ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    {mode === "signin" ? "Signing in..." : "Creating account..."}
                  </span>
                ) : (
                  <span>{mode === "signin" ? "Sign In" : "Create Account"}</span>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
