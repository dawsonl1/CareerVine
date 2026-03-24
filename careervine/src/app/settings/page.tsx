/**
 * Settings page — sidebar navigation with grouped sections
 *
 * Sections:
 *   1. Account: profile + password
 *   2. Integrations: Gmail + Google Calendar connections
 *   3. Availability: working hours + busy calendars
 *   4. AI Templates: custom email generation prompts
 */

"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Navigation from "@/components/navigation";
import AccountSection from "@/components/settings/account-section";
import IntegrationsSection from "@/components/settings/integrations-section";
import AvailabilitySection from "@/components/settings/availability-section";
import TemplatesSection from "@/components/settings/templates-section";
import { User, Plug, Calendar, Sparkles } from "lucide-react";

const tabs = [
  { id: "account", label: "Account", icon: User },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "availability", label: "Availability", icon: Calendar },
  { id: "templates", label: "AI Templates", icon: Sparkles },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function SettingsPageWrapper() {
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}

function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get("tab");
  const activeTab: TabId = tabs.some((t) => t.id === rawTab) ? (rawTab as TabId) : "account";

  const setTab = (tab: TabId) => {
    router.push(`/settings?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-8">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your account and integrations</p>
        </div>

        <div className="flex flex-col md:flex-row gap-8">
          {/* Sidebar nav — desktop: left column, mobile: horizontal scroll */}
          <nav className="md:w-52 shrink-0">
            {/* Mobile: horizontal tabs */}
            <div className="flex md:hidden gap-1 overflow-x-auto pb-2 -mx-1 px-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setTab(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                      active
                        ? "bg-secondary-container text-on-secondary-container"
                        : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Desktop: vertical sidebar */}
            <div className="hidden md:flex flex-col gap-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setTab(tab.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-left cursor-pointer ${
                      active
                        ? "bg-secondary-container text-on-secondary-container"
                        : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0">
            {activeTab === "account" && <AccountSection />}
            {activeTab === "integrations" && <IntegrationsSection />}
            {activeTab === "availability" && <AvailabilitySection />}
            {activeTab === "templates" && <TemplatesSection />}
          </div>
        </div>
      </main>
    </div>
  );
}
