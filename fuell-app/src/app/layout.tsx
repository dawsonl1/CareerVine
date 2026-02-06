/**
 * Root layout component for the Next.js app
 * 
 * This layout wraps all pages with:
 * - HTML document structure
 * - Meta tags and SEO configuration
 * - Tailwind CSS for styling
 * - AuthProvider for authentication context
 * 
 * The AuthProvider wrapper ensures all pages have access to:
 * - User authentication state
 * - Sign up/in/out methods
 * - Session management
 * 
 * This is the root layout that applies to all routes in the app.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";

// Configure Geist fonts for the application
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Metadata for SEO and browser display
export const metadata: Metadata = {
  title: "Networking Helper",
  description: "Manage your professional network",
};

/**
 * Root layout component
 * 
 * @param children - The page content to be rendered
 * @returns JSX element with full HTML structure
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* 
          AuthProvider wraps the entire app to provide authentication context
          to all pages and components. This is essential for the auth flow
          to work properly across the application.
        */}
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
