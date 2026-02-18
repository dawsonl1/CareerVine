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
import { Users, Calendar, CheckSquare, LayoutDashboard, Sprout, Inbox } from "lucide-react";

export default function Navigation() {
  const { user } = useAuth();
  const pathname = usePathname();
  const { gmailConnected, unreadCount } = useCompose();

  if (!user) return null;

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/contacts", label: "Contacts", icon: Users },
    ...(gmailConnected ? [{ href: "/inbox", label: "Inbox", icon: Inbox }] : []),
    { href: "/meetings", label: "Activity", icon: Calendar },
    { href: "/action-items", label: "Actions", icon: CheckSquare },
  ];

  return (
    <nav className="bg-background sticky top-0 z-50 border-b border-outline-variant">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Top bar */}
        <div className="flex justify-between items-center h-16">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <Sprout className="h-7 w-7 text-primary" />
            <span className="text-[22px] font-medium tracking-tight text-foreground">
              CareerVine
            </span>
          </Link>

          {/* Desktop nav tabs */}
          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const badge = item.href === "/inbox" && unreadCount > 0 ? unreadCount : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`state-layer relative flex items-center gap-2 px-4 h-10 rounded-full text-sm font-medium transition-colors ${
                    active
                      ? "bg-secondary-container text-on-secondary-container"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="relative">
                    <Icon className="h-[18px] w-[18px]" />
                    {badge > 0 && (
                      <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none">
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* User area */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-sm font-medium text-foreground leading-tight">
                {user.user_metadata?.first_name || "User"}
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                {user.email}
              </span>
            </div>
            <Link href="/settings" className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-sm font-medium hover:ring-2 hover:ring-primary/30 transition-all" title="Settings">
              {(user.user_metadata?.first_name?.[0] || user.email?.[0] || "U").toUpperCase()}
            </Link>
            <SignOutButton />
          </div>
        </div>

        {/* Mobile bottom-style tabs (rendered below top bar on small screens) */}
        <div className="flex md:hidden -mx-4 overflow-x-auto border-t border-outline-variant">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const badge = item.href === "/inbox" && unreadCount > 0 ? unreadCount : 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex-1 flex flex-col items-center gap-0.5 py-3 text-xs font-medium transition-colors ${
                  active
                    ? "text-primary"
                    : "text-muted-foreground"
                }`}
              >
                <div className={`relative px-5 py-1 rounded-full transition-colors ${active ? "bg-secondary-container" : ""}`}>
                  <Icon className="h-5 w-5" />
                  {badge > 0 && (
                    <span className="absolute -top-1 right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </div>
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
