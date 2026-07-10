"use client";

import { LocationFirstPreviewPage } from "@/components/companies/location-first-preview/preview-page";

export default function PreviewCardsPage({ params }: { params: Promise<{ id: string }> }) {
  return <LocationFirstPreviewPage params={params} variant="cards" />;
}
