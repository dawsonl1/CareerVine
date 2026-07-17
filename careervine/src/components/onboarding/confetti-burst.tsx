"use client";

/**
 * One-shot falling-confetti overlay, extracted from CAR-50's finale so the
 * extension-onboarding flow (CAR-68) can reuse it. Pieces fall for ~2-4.5s
 * and fade out on their own — mount it when the celebration starts.
 */

import { useState } from "react";

const CONFETTI_COLORS = ["#4f6f52", "#e8a13c", "#7ca5b8", "#c96f4a", "#8f5aa5"];

export function ConfettiBurst({ className = "" }: { className?: string }) {
  // Random values are computed once in a lazy state initializer (not during
  // render) so the pieces stay fixed for the overlay's life and render is pure.
  const [pieces] = useState(() =>
    Array.from({ length: 48 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      duration: 2.2 + Math.random() * 1.6,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      rotate: Math.random() * 360,
    })),
  );

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-[-12px] w-2 h-3 rounded-[2px]"
          style={{
            left: `${p.left}%`,
            backgroundColor: p.color,
            transform: `rotate(${p.rotate}deg)`,
            animation: `cv-confetti-fall ${p.duration}s ease-in ${p.delay}s forwards`,
          }}
        />
      ))}
      <style>{`
        @keyframes cv-confetti-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(85vh) rotate(540deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
