"use client";

import { useState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";

interface LogConversationFabProps {
  onClick: () => void;
}

const FULL_TEXT = "Log conversation";
const COLLAPSED_SIZE = 72;
const ICON_SIZE = 32;
const PADDING_X = 28;
const GAP = 12;

export function LogConversationFab({ onClick }: LogConversationFabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const [expandedWidth, setExpandedWidth] = useState(0);

  // Measure the full expanded width once on mount
  useEffect(() => {
    if (textRef.current) {
      const textW = textRef.current.scrollWidth;
      setExpandedWidth(PADDING_X + ICON_SIZE + GAP + textW + PADDING_X);
    }
  }, []);

  const width = isHovered && expandedWidth > 0 ? expandedWidth : COLLAPSED_SIZE;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width,
        transition: "width 400ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 300ms ease",
      }}
      className="fixed bottom-8 right-8 z-40 flex items-center bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl cursor-pointer h-[72px] overflow-hidden"
    >
      {/* Inner content — always laid out at full expanded size, container clips */}
      <div
        className="flex items-center shrink-0"
        style={{ paddingLeft: PADDING_X, paddingRight: PADDING_X, gap: GAP }}
      >
        <Plus className="shrink-0" style={{ width: ICON_SIZE, height: ICON_SIZE }} />
        <span
          ref={textRef}
          className="text-lg font-medium whitespace-nowrap"
          style={{
            opacity: isHovered ? 1 : 0,
            transition: isHovered
              ? "opacity 200ms ease 150ms"  /* fade in after width starts expanding */
              : "opacity 150ms ease",        /* fade out immediately on leave */
          }}
        >
          {FULL_TEXT}
        </span>
      </div>
    </button>
  );
}
