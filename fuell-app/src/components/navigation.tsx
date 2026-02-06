/**
 * Navigation component - Main app navigation bar
 * 
 * This component provides:
 * - Consistent navigation across all authenticated pages
 * - Active page highlighting
 * - User info display
 * - Sign out functionality
 * - Responsive design
 * 
 * Only renders when user is authenticated to avoid showing navigation
 * to unauthenticated users.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import SignOutButton from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { User, Menu } from "lucide-react";

export default function Navigation() {
  // Get current user from auth context
  const { user } = useAuth();
  
  // Get current route to determine active navigation item
  const pathname = usePathname();

  // Don't render navigation if user is not authenticated
  if (!user) return null;

  // Define navigation items with their paths and labels
  // These correspond to the main sections of the app
  const navItems = [
    { href: "/", label: "Dashboard" },
    { href: "/contacts", label: "Contacts" },
    { href: "/meetings", label: "Meetings" },
    { href: "/action-items", label: "Action Items" },
  ];

  return (
    <nav className="bg-background border-b border-border sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Left side: App title and navigation links */}
          <div className="flex items-center space-x-8">
            {/* App title - links back to dashboard */}
            <Link href="/" className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-sm">NH</span>
              </div>
              <span className="text-xl font-bold text-foreground">Networking Helper</span>
            </Link>
            
            {/* Navigation links - only shown on medium screens and up */}
            <div className="hidden md:flex space-x-1">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    // Highlight active page with primary color
                    pathname === item.href
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Right side: User info and sign out */}
          <div className="flex items-center space-x-4">
            {/* Mobile menu button - shown on small screens */}
            <div className="md:hidden">
              <Button variant="ghost" size="sm">
                <Menu className="h-5 w-5" />
              </Button>
            </div>
            
            {/* User avatar and info */}
            <div className="flex items-center space-x-3">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-sm font-medium text-foreground">
                  {user.user_metadata?.first_name || 'User'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
              <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                <User className="h-4 w-4 text-primary" />
              </div>
              <SignOutButton />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
