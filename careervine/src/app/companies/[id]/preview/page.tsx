"use client";

import { use } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { PREVIEW_VARIANTS } from "@/lib/company-location-preview";
import { ArrowLeft, ArrowRight, Layers } from "lucide-react";

export default function CompanyPreviewHubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const companyId = Number(id);
  const { user } = useAuth();

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link
          href={`/companies/${companyId}`}
          className="group inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-6 -ml-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-surface-container-high"
        >
          <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" /> Back to company
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <Layers className="w-7 h-7 text-primary" />
          <h1 className="text-2xl font-semibold text-on-surface">Location-first previews</h1>
        </div>
        <p className="text-sm text-on-surface-variant mb-8">
          Layout options for §20 — company identity at the top, recruiting state per location.{" "}
          <strong className="text-on-surface font-medium">Start with Tabs</strong> (closest to today&apos;s page).
          Uses live contact data; target status is mocked.
        </p>

        <div className="grid gap-3">
          {PREVIEW_VARIANTS.map((v) => (
            <Link key={v.slug} href={`/companies/${companyId}/preview/${v.slug}`} className="block group">
              <Card className="transition-shadow group-hover:shadow-md">
                <CardContent className="py-4 px-5 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <h2 className="font-medium text-on-surface">{v.label}</h2>
                    <p className="text-sm text-on-surface-variant mt-0.5">{v.desc}</p>
                    <p className="text-xs text-primary mt-2 font-mono truncate">
                      /companies/{companyId}/preview/{v.slug}
                    </p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-on-surface-variant group-hover:text-primary shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
