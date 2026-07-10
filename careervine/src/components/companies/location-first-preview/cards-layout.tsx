"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { PreviewLocationBlock } from "@/lib/company-location-preview";
import {
  LocationBlockHeader,
  LocationWorkspace,
  STATUS_LABELS,
  STATUS_STYLES,
} from "./shared";
import { Target, X } from "lucide-react";

export function CardsLayout({ blocks }: { blocks: PreviewLocationBlock[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = blocks.find((b) => b.key === selectedKey) ?? null;

  return (
    <>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {blocks.map((block) => (
          <button
            key={block.key}
            type="button"
            onClick={() => setSelectedKey(block.key)}
            className="text-left"
          >
            <Card
              className={`h-full transition-shadow hover:shadow-md ${
                block.isTargeted ? "ring-1 ring-primary/30" : ""
              } ${selectedKey === block.key ? "ring-2 ring-primary" : ""}`}
            >
              <CardContent className="py-4 px-4 flex flex-col h-full min-h-[140px]">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h2 className="font-semibold text-on-surface text-sm leading-snug">{block.label}</h2>
                  {block.isTargeted ? (
                    <Target className="w-4 h-4 text-primary shrink-0" />
                  ) : null}
                </div>
                <p className="text-xs text-on-surface-variant">
                  {block.contactCount} contact{block.contactCount === 1 ? "" : "s"}
                </p>
                {block.isTargeted && block.status && (
                  <span
                    className={`mt-2 self-start px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_STYLES[block.status]}`}
                  >
                    {STATUS_LABELS[block.status]}
                  </span>
                )}
                {block.isTargeted && block.next_app_date && (
                  <p className="text-[10px] text-primary mt-1 font-medium">
                    Apps {new Date(`${block.next_app_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </p>
                )}
                <p className="text-[10px] text-primary mt-auto pt-3">Click for details →</p>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-40 bg-scrim/40 flex justify-end"
          onClick={() => setSelectedKey(null)}
          onKeyDown={() => {}}
          role="presentation"
        >
          <div
            className="w-full max-w-lg h-full bg-background shadow-xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
            role="dialog"
            aria-label={`${selected.label} details`}
          >
            <div className="sticky top-0 bg-background border-b border-outline-variant/30 px-5 py-4 flex items-center justify-between">
              <h2 className="font-semibold text-on-surface">{selected.label}</h2>
              <Button variant="text" size="sm" onClick={() => setSelectedKey(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-5">
              <LocationBlockHeader block={selected} />
              {selected.isTargeted ? (
                <LocationWorkspace block={selected} compactPeople={false} />
              ) : (
                <div className="mt-6 space-y-3">
                  <p className="text-sm text-on-surface-variant">Not targeted yet.</p>
                  <Button variant="tonal" disabled>
                    Target this location
                  </Button>
                  <LocationWorkspace block={selected} compactPeople={false} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
