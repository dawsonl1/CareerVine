"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { PreviewLocationBlock } from "@/lib/company-location-preview";
import {
  LocationBlockHeader,
  LocationWorkspace,
  STATUS_LABELS,
  STATUS_STYLES,
} from "./shared";
import { Target } from "lucide-react";

export function SplitLayout({ blocks }: { blocks: PreviewLocationBlock[] }) {
  const defaultKey = useMemo(
    () => blocks.find((b) => b.isTargeted)?.key ?? blocks[0]?.key ?? null,
    [blocks],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(defaultKey);
  const selected = blocks.find((b) => b.key === selectedKey) ?? blocks[0] ?? null;

  return (
    <div className="grid lg:grid-cols-[minmax(220px,280px)_1fr] gap-6 min-h-[480px]">
      <Card className="h-fit lg:sticky lg:top-24">
        <CardContent className="p-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant px-3 py-2">
            Locations
          </p>
          <ul className="space-y-0.5">
            {blocks.map((block) => {
              const active = block.key === selectedKey;
              return (
                <li key={block.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(block.key)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                      active ? "bg-primary-container text-on-primary-container" : "hover:bg-surface-container-high"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{block.label}</span>
                      {block.isTargeted && (
                        <Target className={`w-3.5 h-3.5 shrink-0 ${active ? "" : "text-primary"}`} />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className={`text-[10px] ${active ? "opacity-90" : "text-on-surface-variant"}`}>
                        {block.contactCount} contacts
                      </span>
                      {block.isTargeted && block.status && (
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                            active ? "bg-surface/20" : STATUS_STYLES[block.status]
                          }`}
                        >
                          {STATUS_LABELS[block.status]}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card className="min-h-[400px]">
        <CardContent className="py-5 px-6">
          {selected ? (
            <>
              <LocationBlockHeader block={selected} />
              {selected.isTargeted ? (
                <LocationWorkspace block={selected} compactPeople={false} />
              ) : (
                <div className="mt-6 space-y-4">
                  <p className="text-sm text-on-surface-variant">
                    This location isn&apos;t targeted. Browse people below or add it to your targets.
                  </p>
                  <LocationWorkspace block={selected} compactPeople={false} />
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-on-surface-variant">Select a location</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
