"use client";

import { useState } from "react";
import { useAuth } from "./auth-provider";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
  Mail, Lock, User, Eye, EyeOff, Sprout, CheckCircle, ArrowLeft,
  MessageSquare, ListChecks, Heart,
} from "lucide-react";

type Mode = "signin" | "signup" | "forgot" | "check-email" | "forgot-sent";

interface AuthFormProps {
  initialMode?: "signin" | "signup";
  onBack?: () => void;
}

export default function AuthForm({ initialMode = "signin", onBack }: AuthFormProps) {
  const { signUp, signIn, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    firstName: "",
    lastName: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (mode === "signup") {
        const result = await signUp(formData.email, formData.password, formData.firstName, formData.lastName);
        if (result.error) {
          setError(result.error);
        } else {
          setMode("check-email");
        }
      } else if (mode === "signin") {
        const result = await signIn(formData.email, formData.password);
        if (result.error) {
          if (result.error.toLowerCase().includes("email not confirmed")) {
            setMode("check-email");
          } else {
            setError(result.error);
          }
        }
      } else if (mode === "forgot") {
        const result = await resetPassword(formData.email);
        if (result.error) {
          setError(result.error);
        } else {
          setMode("forgot-sent");
        }
      }
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const switchMode = (next: Mode) => {
    setError("");
    setMode(next);
  };

  const inputClasses =
    "w-full h-14 pl-12 pr-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-base";

  const heading = {
    signin: "Welcome back",
    signup: "Get started",
    forgot: "Reset password",
    "check-email": "Check your email",
    "forgot-sent": "Email sent",
  }[mode];

  const subheading = {
    signin: "Sign in to CareerVine",
    signup: "Create your CareerVine account",
    forgot: "We'll send you a reset link",
    "check-email": "Confirm your email to continue",
    "forgot-sent": "Check your inbox for a reset link",
  }[mode];

  // Contextual selling points based on mode
  const isSignUp = mode === "signup" || mode === "check-email";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="w-full border-b border-outline-variant bg-background/95 backdrop-blur px-6 py-3 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <Sprout className="h-7 w-7 text-primary" />
          <span className="text-lg font-medium text-foreground">CareerVine</span>
        </button>
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        )}
      </header>

      {/* Main content — split layout on desktop */}
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Left panel — contextual messaging */}
        <div className="hidden md:flex md:w-[45%] lg:w-[50%] bg-primary-container/10 items-center justify-center p-12">
          <div className="max-w-md">
            {isSignUp ? (
              <>
                <h2 className="text-[28px] leading-9 font-normal text-foreground mb-3">
                  Your network is your biggest asset.
                  <br />
                  <span className="text-primary">Start treating it like one.</span>
                </h2>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  Free to use. Set up in under a minute.
                </p>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center shrink-0 mt-0.5">
                      <MessageSquare className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Remember every conversation</p>
                      <p className="text-xs text-muted-foreground">Log meetings, calls, and coffee chats in seconds</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center shrink-0 mt-0.5">
                      <ListChecks className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Never forget a promise</p>
                      <p className="text-xs text-muted-foreground">Track action items tied to conversations</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center shrink-0 mt-0.5">
                      <Heart className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Know who needs attention</p>
                      <p className="text-xs text-muted-foreground">Follow-up cadences keep relationships warm</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-[28px] leading-9 font-normal text-foreground mb-3">
                  Welcome back.
                  <br />
                  <span className="text-primary">Your network is waiting.</span>
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Pick up right where you left off — your conversations,
                  action items, and follow-ups are all here.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Right panel — auth form */}
        <div className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-[420px]">
            {/* Brand header */}
            <div className="text-center mb-10">
              <Sprout className="mx-auto h-12 w-12 text-primary mb-4 md:hidden" />
              <h1 className="text-[28px] leading-9 font-normal text-foreground mb-1">{heading}</h1>
              <p className="text-sm text-muted-foreground">{subheading}</p>
            </div>

            {/* Email confirmation screen */}
            {(mode === "check-email" || mode === "forgot-sent") ? (
              <Card variant="outlined">
                <CardContent className="px-6 py-8 text-center space-y-5">
                  <div className="flex justify-center">
                    <div className="w-16 h-16 rounded-full bg-primary-container flex items-center justify-center">
                      <CheckCircle className="h-8 w-8 text-primary" />
                    </div>
                  </div>
                  {mode === "check-email" ? (
                    <>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        We sent a confirmation link to{" "}
                        <span className="font-medium text-foreground">{formData.email}</span>.
                        Click the link in your email to activate your account, then sign in.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Don't see it? Check your spam folder.
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      A password reset link was sent to{" "}
                      <span className="font-medium text-foreground">{formData.email}</span>.
                      Check your inbox and follow the instructions.
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="tonal"
                    className="w-full"
                    onClick={() => switchMode("signin")}
                  >
                    Back to sign in
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card variant="outlined">
                <CardContent className="px-6 py-8">
                  <form className="space-y-5" onSubmit={handleSubmit}>
                    {/* Error */}
                    {error && (
                      <div className="bg-error-container text-on-error-container px-4 py-3 rounded-[12px] text-sm">
                        {error}
                      </div>
                    )}

                    {/* Name fields — sign up only, shown first */}
                    {mode === "signup" && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="relative">
                          <User className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                          <input
                            id="firstName"
                            name="firstName"
                            type="text"
                            autoComplete="given-name"
                            required
                            value={formData.firstName}
                            onChange={handleChange}
                            className={inputClasses}
                            placeholder="First name"
                          />
                        </div>
                        <div className="relative">
                          <User className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                          <input
                            id="lastName"
                            name="lastName"
                            type="text"
                            autoComplete="family-name"
                            required
                            value={formData.lastName}
                            onChange={handleChange}
                            className={inputClasses}
                            placeholder="Last name"
                          />
                        </div>
                      </div>
                    )}

                    {/* Email */}
                    <div className="relative">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                      <input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        value={formData.email}
                        onChange={handleChange}
                        className={inputClasses}
                        placeholder="Email"
                      />
                    </div>

                    {/* Password — hidden in forgot mode */}
                    {mode !== "forgot" && (
                      <div className="relative">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <input
                          id="password"
                          name="password"
                          type={showPassword ? "text" : "password"}
                          autoComplete={mode === "signin" ? "current-password" : "new-password"}
                          required
                          minLength={mode === "signup" ? 8 : undefined}
                          value={formData.password}
                          onChange={handleChange}
                          className={`${inputClasses} !pr-12`}
                          placeholder="Password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                        </button>
                      </div>
                    )}

                    {/* Password hint for signup */}
                    {mode === "signup" && (
                      <p className="text-xs text-muted-foreground -mt-3 pl-1">
                        Minimum 8 characters
                      </p>
                    )}

                    {/* Forgot password link */}
                    {mode === "signin" && (
                      <div className="text-right -mt-2">
                        <button
                          type="button"
                          onClick={() => switchMode("forgot")}
                          className="text-xs text-primary hover:underline cursor-pointer"
                        >
                          Forgot password?
                        </button>
                      </div>
                    )}

                    {/* Submit */}
                    <Button type="submit" className="w-full" size="lg" loading={loading}>
                      {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
                    </Button>

                    {/* Back link for forgot */}
                    {mode === "forgot" && (
                      <button
                        type="button"
                        onClick={() => switchMode("signin")}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer mx-auto"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
                      </button>
                    )}
                  </form>

                  {/* Mode toggle */}
                  {mode !== "forgot" && (
                    <div className="text-center mt-6">
                      <p className="text-sm text-muted-foreground">
                        {mode === "signin" ? (
                          <>
                            New to CareerVine?{" "}
                            <button
                              type="button"
                              onClick={() => switchMode("signup")}
                              className="font-medium text-primary hover:underline cursor-pointer"
                            >
                              Create an account
                            </button>
                          </>
                        ) : (
                          <>
                            Already have an account?{" "}
                            <button
                              type="button"
                              onClick={() => switchMode("signin")}
                              className="font-medium text-primary hover:underline cursor-pointer"
                            >
                              Sign in
                            </button>
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
