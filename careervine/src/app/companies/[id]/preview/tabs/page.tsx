"use client";

import { Suspense } from "react";
import { LocationFirstPreviewPage } from "@/components/companies/location-first-preview/preview-page";

export default function PreviewTabsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <LocationFirstPreviewPage params={params} variant="tabs" />
    </Suspense>
  );
}
