/**
 * Navigation component — M3 top app bar + navigation tabs
 *
 * Follows Material Design 3 conventions:
 *   - Surface background for the app bar
 *   - M3 navigation tabs with active indicator pill
 *   - On-surface / on-surface-variant text colours
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import SignOutButton from "@/components/sign-out-button";
import { Users, Calendar, CheckSquare, LayoutDashboard, Sprout, Inbox, MessageSquare } from "lucide-react";
import SetupBanner from "@/components/setup-banner";

export default function Navigation() {
  const { user } = useAuth();
  const pathname = usePathname();
  const { gmailConnected, unreadCount } = useCompose();

  if (!user) return null;

  const navItems = [
    { href: "/", label: "Home", icon: LayoutDashboard, onboardingTarget: "nav-home" },
    { href: "/meetings", label: "Activity", icon: MessageSquare },
    { href: "/contacts", label: "Contacts", icon: Users },
    { href: "/action-items", label: "Actions", icon: CheckSquare },
  ];

  return (
    <nav className="bg-background sticky top-0 z-50 border-b border-outline-variant">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Top bar */}
        <div className="flex justify-between items-center h-[72px]">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <Sprout className="h-8 w-8 text-primary" />
            <span className="text-[26px] font-medium tracking-tight text-foreground">
              CareerVine
            </span>
          </Link>

          {/* Desktop nav tabs */}
          <div className="hidden md:flex items-center gap-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  {...(item.onboardingTarget ? { "data-onboarding-target": item.onboardingTarget } : {})}
                  className={`state-layer flex items-center gap-2.5 px-5 h-11 rounded-full text-base font-medium transition-colors ${
                    active
                      ? "bg-secondary-container text-on-secondary-container"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* User area */}
          <div className="flex items-center gap-2.5">
            {/* Inbox icon — always visible, shows indicator when not connected */}
            <Link
              href={gmailConnected ? "/inbox" : "/settings?tab=integrations"}
              data-onboarding-target="nav-inbox"
              className={`state-layer relative w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
                pathname.startsWith("/inbox")
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title={gmailConnected ? "Inbox" : "Connect Gmail to use Inbox"}
            >
              <Inbox className="h-5 w-5" />
              {gmailConnected && unreadCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              {!gmailConnected && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-amber-500 border-2 border-background" />
              )}
            </Link>
            {/* Calendar icon */}
            <Link
              href="/calendar"
              className={`state-layer w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
                pathname.startsWith("/calendar")
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Calendar"
            >
              <Calendar className="h-5 w-5" />
            </Link>
            <div className="hidden sm:flex flex-col items-end ml-1">
              <span className="text-base font-medium text-foreground leading-tight">
                {user.user_metadata?.first_name || "User"}
              </span>
              <span className="text-sm text-muted-foreground leading-tight">
                {user.email}
              </span>
            </div>
            <Link href="/settings" className="w-11 h-11 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-base font-medium hover:ring-2 hover:ring-primary/30 transition-all" title="Settings">
              {(user.user_metadata?.first_name?.[0] || user.email?.[0] || "U").toUpperCase()}
            </Link>
            <SignOutButton />
          </div>
        </div>

        {/* Mobile bottom-style tabs (rendered below top bar on small screens) */}
        <div className="flex md:hidden -mx-4 border-t border-outline-variant">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                {...(item.onboardingTarget ? { "data-onboarding-target": item.onboardingTarget } : {})}
                className={`flex-1 flex flex-col items-center gap-0.5 py-3 text-xs font-medium transition-colors ${
                  active
                    ? "text-primary"
                    : "text-muted-foreground"
                }`}
              >
                <div className={`px-5 py-1 rounded-full transition-colors ${active ? "bg-secondary-container" : ""}`}>
                  <Icon className="h-5 w-5" />
                </div>
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
      <SetupBanner />
    </nav>
  );
}
