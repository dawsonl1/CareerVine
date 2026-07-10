"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";

/**
 * How far past the viewport an avatar starts loading its photo, in px.
 * ≈30 list rows (~80px each) — close enough that scrolling never catches
 * up to unloaded avatars, far enough that opening a 2,000-contact list
 * doesn't fetch 2,000 images.
 */
const PRELOAD_MARGIN_PX = 2400;

// useLayoutEffect warns during SSR (client components still server-render
// for initial HTML); on the server the effect is a no-op either way.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface ContactAvatarProps {
  name: string;
  photoUrl: string | null | undefined;
  className?: string;
  /** Optional ring/border color class (e.g. "ring-red-400") to indicate status */
  ringClassName?: string;
}

export function ContactAvatar({ name, photoUrl, className = "", ringClassName = "" }: ContactAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Reset error state when the photo URL changes (e.g. after re-import)
  useEffect(() => setImgError(false), [photoUrl]);

  // Load the photo once the avatar is within the preload window. The
  // pre-paint bounds check runs synchronously so on-screen avatars never
  // flash their initial letter; the observer handles everything below the
  // fold as it scrolls closer.
  useIsomorphicLayoutEffect(() => {
    if (!photoUrl || shouldLoad) return;
    const el = imgRef.current ?? holderRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    if (
      rect.bottom > -PRELOAD_MARGIN_PX &&
      rect.top < window.innerHeight + PRELOAD_MARGIN_PX &&
      rect.right > -PRELOAD_MARGIN_PX &&
      rect.left < window.innerWidth + PRELOAD_MARGIN_PX
    ) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${PRELOAD_MARGIN_PX}px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [photoUrl, shouldLoad]);

  const initial = name.charAt(0).toUpperCase();
  const ring = ringClassName ? `ring-[3px] ${ringClassName}` : "";

  if (photoUrl && !imgError && shouldLoad) {
    return (
      <img
        ref={imgRef}
        src={photoUrl}
        alt={name}
        decoding="async"
        referrerPolicy="no-referrer"
        className={`rounded-full object-cover shrink-0 ${ring} ${className}`}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div
      ref={holderRef}
      className={`rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container font-medium ${ring} ${className}`}
    >
      {initial}
    </div>
  );
}
