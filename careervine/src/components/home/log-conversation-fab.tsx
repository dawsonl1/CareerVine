"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Plus } from "lucide-react";

interface LogConversationFabProps {
  onClick: () => void;
}

const FULL_TEXT = "Log conversation";
const COLLAPSED_SIZE = 72;
const ICON_SIZE = 32;
const EXPANDED_PADDING_X = 24;
const GAP = 10;
const TYPE_SPEED = 40; // ms per character
const TYPE_START_DELAY = 250; // ms before typing starts (let width expand first)

export function LogConversationFab({ onClick }: LogConversationFabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [displayedChars, setDisplayedChars] = useState(0);
  const [showCursor, setShowCursor] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const [expandedWidth, setExpandedWidth] = useState(0);
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Measure the full expanded width once on mount
  useEffect(() => {
    if (textRef.current) {
      const textW = textRef.current.scrollWidth;
      setExpandedWidth(EXPANDED_PADDING_X + ICON_SIZE + GAP + textW + EXPANDED_PADDING_X);
    }
  }, []);

  // Typing effect
  const startTyping = useCallback(() => {
    setDisplayedChars(0);
    setShowCursor(true);

    // Start cursor blink
    if (cursorTimerRef.current) clearInterval(cursorTimerRef.current);
    cursorTimerRef.current = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);

    // Start typing after delay
    let charIndex = 0;
    const typeNext = () => {
      charIndex++;
      setDisplayedChars(charIndex);
      if (charIndex < FULL_TEXT.length) {
        typeTimerRef.current = setTimeout(typeNext, TYPE_SPEED);
      } else {
        // Done typing — keep cursor visible
        setShowCursor(true);
      }
    };
    typeTimerRef.current = setTimeout(typeNext, TYPE_START_DELAY);
  }, []);

  const stopTyping = useCallback(() => {
    if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    if (cursorTimerRef.current) clearInterval(cursorTimerRef.current);
    setDisplayedChars(0);
    setShowCursor(false);
  }, []);

  useEffect(() => {
    if (isHovered) {
      startTyping();
    } else {
      stopTyping();
    }
    return () => {
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      if (cursorTimerRef.current) clearInterval(cursorTimerRef.current);
    };
  }, [isHovered, startTyping, stopTyping]);

  const width = isHovered && expandedWidth > 0 ? expandedWidth : COLLAPSED_SIZE;

  // When collapsed, center the icon: (72 - 32) / 2 = 20px
  // When expanded, use the normal padding
  const iconPaddingLeft = isHovered ? EXPANDED_PADDING_X : (COLLAPSED_SIZE - ICON_SIZE) / 2;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width,
        transition: "width 500ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 300ms ease",
      }}
      className="fixed bottom-8 right-8 z-40 flex items-center bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl cursor-pointer h-[72px] overflow-hidden"
    >
      <div
        className="flex items-center shrink-0"
        style={{
          paddingLeft: iconPaddingLeft,
          paddingRight: isHovered ? EXPANDED_PADDING_X : 0,
          gap: isHovered ? GAP : 0,
          transition: "padding-left 500ms cubic-bezier(0.4, 0, 0.2, 1), padding-right 500ms cubic-bezier(0.4, 0, 0.2, 1), gap 500ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <Plus className="shrink-0" style={{ width: ICON_SIZE, height: ICON_SIZE }} />

        {/* Hidden measurer */}
        <span
          ref={textRef}
          className="text-lg font-medium whitespace-nowrap absolute opacity-0 pointer-events-none"
          aria-hidden
        >
          {FULL_TEXT}
        </span>

        {/* Typed text + cursor */}
        <span className="text-lg font-medium whitespace-nowrap">
          {FULL_TEXT.slice(0, displayedChars)}
          {isHovered && (
            <span
              className="inline-block w-[2px] h-[1.1em] bg-primary-foreground align-middle ml-[1px]"
              style={{ opacity: showCursor ? 1 : 0 }}
            />
          )}
        </span>
      </div>
    </button>
  );
}
