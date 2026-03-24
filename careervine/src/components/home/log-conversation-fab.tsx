"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Plus } from "lucide-react";

interface LogConversationFabProps {
  onClick: () => void;
}

const FULL_TEXT = "Log conversation";
const TYPE_SPEED = 40; // ms per character typing
const DELETE_SPEED = 30; // ms per character deleting

export function LogConversationFab({ onClick }: LogConversationFabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [displayText, setDisplayText] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const targetRef = useRef<"type" | "delete">("delete");

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();

    if (isHovered) {
      targetRef.current = "type";
      intervalRef.current = setInterval(() => {
        setDisplayText((prev) => {
          if (prev.length >= FULL_TEXT.length) {
            clearTimer();
            return FULL_TEXT;
          }
          return FULL_TEXT.slice(0, prev.length + 1);
        });
      }, TYPE_SPEED);
    } else {
      targetRef.current = "delete";
      intervalRef.current = setInterval(() => {
        setDisplayText((prev) => {
          if (prev.length <= 0) {
            clearTimer();
            return "";
          }
          return prev.slice(0, -1);
        });
      }, DELETE_SPEED);
    }

    return clearTimer;
  }, [isHovered, clearTimer]);

  const showText = displayText.length > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="fixed bottom-8 right-8 z-40 flex items-center gap-2.5 bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl transition-shadow cursor-pointer h-16 px-5"
      style={{ minWidth: 64 }}
    >
      <Plus className="h-7 w-7 shrink-0" />
      {showText && (
        <span className="text-base font-medium whitespace-nowrap overflow-hidden pr-1">
          {displayText}
          <span className="inline-block w-[2px] h-[16px] bg-primary-foreground/70 ml-[1px] align-middle animate-pulse" />
        </span>
      )}
    </button>
  );
}
