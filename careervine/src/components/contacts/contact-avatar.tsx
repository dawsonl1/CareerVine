"use client";

import { useState } from "react";

interface ContactAvatarProps {
  name: string;
  photoUrl: string | null | undefined;
  className?: string;
  /** Optional ring/border color class (e.g. "ring-red-400") to indicate status */
  ringClassName?: string;
}

export function ContactAvatar({ name, photoUrl, className = "", ringClassName = "" }: ContactAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const initial = name.charAt(0).toUpperCase();
  const ring = ringClassName ? `ring-2 ${ringClassName}` : "";

  if (photoUrl && !imgError) {
    return (
      <img
        src={photoUrl}
        alt={name}
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
