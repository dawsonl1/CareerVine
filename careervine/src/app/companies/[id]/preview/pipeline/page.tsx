"use client";

import { Suspense } from "react";
import { LocationFirstPreviewPage } from "@/components/companies/location-first-preview/preview-page";

export default function PreviewPipelinePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <LocationFirstPreviewPage params={params} variant="pipeline" />
    </Suspense>
  );
}
