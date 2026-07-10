"use client";

import { LocationFirstPreviewPage } from "@/components/companies/location-first-preview/preview-page";

export default function PreviewAccordionPage({ params }: { params: Promise<{ id: string }> }) {
  return <LocationFirstPreviewPage params={params} variant="accordion" />;
}
