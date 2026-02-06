/**
 * Home page - Main dashboard and authentication entry point
 * 
 * This page serves as the root of the application and handles two states:
 * 1. Unauthenticated: Shows the authentication form (sign up/in)
 * 2. Authenticated: Shows the dashboard with navigation to main features
 * 
 * The page uses the useAuth hook to:
 * - Check authentication status
 * - Show loading state while checking auth
 * - Display appropriate UI based on auth state
 * 
 * For authenticated users, it displays a grid of navigation cards
 * that link to the main sections of the app.
 */

"use client";

import { useAuth } from "@/components/auth-provider";
import AuthForm from "@/components/auth-form";
import Navigation from "@/components/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, Calendar, CheckSquare, MessageSquare } from "lucide-react";

export default function Home() {
  // Get authentication state and methods from context
  const { user, loading } = useAuth();

  // Show loading spinner while checking authentication
  // This happens on initial page load while we check for existing session
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // If no user is authenticated, show the authentication form
  // The AuthForm component handles both sign up and sign in
  if (!user) {
    return <AuthForm />;
  }

  // User is authenticated - show the main dashboard
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation bar with user info and sign out */}
      <Navigation />

      {/* Main content area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome section */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">
            Welcome back, {user?.user_metadata?.first_name || 'User'}!
          </h1>
          <p className="text-muted-foreground">
            Manage your professional network and track your connections
          </p>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center space-x-2">
                <Users className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">0</p>
                  <p className="text-sm text-muted-foreground">Total Contacts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center space-x-2">
                <Calendar className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">0</p>
                  <p className="text-sm text-muted-foreground">Upcoming Meetings</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center space-x-2">
                <CheckSquare className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">0</p>
                  <p className="text-sm text-muted-foreground">Action Items</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center space-x-2">
                <MessageSquare className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">0</p>
                  <p className="text-sm text-muted-foreground">Interactions</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Navigation cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer group">
            <CardHeader>
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                  <Users className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Contacts</h2>
                  <p className="text-sm text-muted-foreground">Manage your professional network</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button className="w-full" variant="outline" onClick={() => window.location.href = '/contacts'}>
                View Contacts
              </Button>
            </CardContent>
          </Card>
          
          <Card className="hover:shadow-lg transition-shadow cursor-pointer group">
            <CardHeader>
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                  <Calendar className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Meetings</h2>
                  <p className="text-sm text-muted-foreground">Track meetings and interactions</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button className="w-full" variant="outline" onClick={() => window.location.href = '/meetings'}>
                View Meetings
              </Button>
            </CardContent>
          </Card>
          
          <Card className="hover:shadow-lg transition-shadow cursor-pointer group">
            <CardHeader>
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                  <CheckSquare className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Action Items</h2>
                  <p className="text-sm text-muted-foreground">Follow up on important tasks</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button className="w-full" variant="outline" onClick={() => window.location.href = '/action-items'}>
                View Action Items
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
