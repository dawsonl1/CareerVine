"use client";

import { useState } from "react";

interface ContactAvatarProps {
  name: string;
  photoUrl: string | null | undefined;
  className: string;
}

export function ContactAvatar({ name, photoUrl, className }: ContactAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const initial = name.charAt(0).toUpperCase();

  if (photoUrl && !imgError) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className={`rounded-full object-cover shrink-0 ${className}`}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div className={`rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container font-medium ${className}`}>
      {initial}
    </div>
  );
}
