"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { PreviewLocationBlock } from "@/lib/company-location-preview";
import { LocationBlockHeader, LocationWorkspace } from "./shared";

export function StackLayout({ blocks }: { blocks: PreviewLocationBlock[] }) {
  return (
    <div className="space-y-4 max-w-4xl">
      {blocks.map((block) => (
        <Card
          key={block.key}
          className={block.isTargeted ? "ring-1 ring-primary/25 shadow-sm" : "opacity-90"}
        >
          <CardContent className="py-4 px-5">
            <LocationBlockHeader block={block} />
            {block.isTargeted ? (
              <LocationWorkspace block={block} />
            ) : (
              <p className="text-xs text-on-surface-variant mt-3 pl-6">
                Collapsed — target this location to track status, notes, and outreach here.
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
