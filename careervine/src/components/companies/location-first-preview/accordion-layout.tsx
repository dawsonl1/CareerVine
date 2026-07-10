"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { PreviewLocationBlock } from "@/lib/company-location-preview";
import { LocationBlockHeader, LocationWorkspace } from "./shared";

export function AccordionLayout({ blocks }: { blocks: PreviewLocationBlock[] }) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(
    () => new Set(blocks.filter((b) => b.isTargeted).map((b) => b.key)),
  );

  const toggle = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Card className="max-w-3xl overflow-hidden">
      <CardContent className="p-0 divide-y divide-outline-variant/30">
        {blocks.map((block) => {
          const open = openKeys.has(block.key);
          return (
            <div key={block.key} className={block.isTargeted ? "bg-primary/[0.03]" : ""}>
              <div className="px-5 py-3.5">
                <LocationBlockHeader block={block} expanded={open} onToggle={() => toggle(block.key)} />
                {open && <LocationWorkspace block={block} compactPeople />}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
