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
import { ComposeEmailProvider } from "@/components/compose-email-context";
import { ComposeEmailModal } from "@/components/compose-email-modal";
import { QuickCaptureProvider } from "@/components/quick-capture-context";
import { QuickCaptureModal } from "@/components/quick-capture-modal";
import { ToastProvider } from "@/components/ui/toast";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// Configure Geist fonts for the application
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Metadata for SEO, social sharing, and AI crawlers
export const metadata: Metadata = {
  title: "CareerVine — Personal CRM for Professional Networking",
  description:
    "Track conversations, follow up on promises, and keep your professional relationships warm. A personal CRM that helps you remember every coffee chat, action item, and intro you said you'd make.",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  metadataBase: new URL("https://careervine.app"),
  openGraph: {
    title: "CareerVine — Personal CRM for Professional Networking",
    description:
      "Track conversations, follow up on promises, and keep your professional relationships warm.",
    url: "https://careervine.app",
    siteName: "CareerVine",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "CareerVine — Personal CRM for Professional Networking",
    description:
      "Track conversations, follow up on promises, and keep your professional relationships warm.",
  },
  robots: {
    index: true,
    follow: true,
  },
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
          <ToastProvider>
            <ComposeEmailProvider>
              <QuickCaptureProvider>
                {children}
                <ComposeEmailModal />
                <QuickCaptureModal />
              </QuickCaptureProvider>
            </ComposeEmailProvider>
          </ToastProvider>
        </AuthProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
