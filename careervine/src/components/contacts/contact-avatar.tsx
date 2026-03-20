"use client";

import { useState, useEffect } from "react";

interface ContactAvatarProps {
  name: string;
  photoUrl: string | null | undefined;
  className?: string;
  /** Optional ring/border color class (e.g. "ring-red-400") to indicate status */
  ringClassName?: string;
}

export function ContactAvatar({ name, photoUrl, className = "", ringClassName = "" }: ContactAvatarProps) {
  const [imgError, setImgError] = useState(false);

  // Reset error state when the photo URL changes (e.g. after re-import)
  useEffect(() => setImgError(false), [photoUrl]);
  const initial = name.charAt(0).toUpperCase();
  const ring = ringClassName ? `ring-[3px] ${ringClassName}` : "";

  if (photoUrl && !imgError) {
    return (
      <img
        src={photoUrl}
        alt={name}
        referrerPolicy="no-referrer"
        className={`rounded-full object-cover shrink-0 ${ring} ${className}`}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div className={`rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container font-medium ${ring} ${className}`}>
      {initial}
    </div>
  );
}
