"use client";

import { useState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";

interface LogConversationFabProps {
  onClick: () => void;
}

const FULL_TEXT = "Log conversation";

export function LogConversationFab({ onClick }: LogConversationFabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const [textWidth, setTextWidth] = useState(0);

  // Measure the full text width once on mount
  useEffect(() => {
    if (textRef.current) {
      setTextWidth(textRef.current.scrollWidth);
    }
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="fixed bottom-8 right-8 z-40 flex items-center bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl transition-all duration-300 ease-in-out cursor-pointer h-[72px] w-[72px] hover:w-auto justify-center hover:justify-start hover:px-7 hover:gap-3"
    >
      <Plus className="h-8 w-8 shrink-0" />
      {/* Hidden measurer */}
      <span
        ref={textRef}
        className="text-lg font-medium whitespace-nowrap absolute opacity-0 pointer-events-none"
        aria-hidden
      >
        {FULL_TEXT}
      </span>
      {/* Animated text container */}
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{ width: isHovered ? textWidth : 0, opacity: isHovered ? 1 : 0 }}
      >
        <span className="text-lg font-medium whitespace-nowrap">
          {FULL_TEXT}
        </span>
      </div>
    </button>
  );
}
