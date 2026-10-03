"use client";
import { useState } from "react";

// Listing photos disappear when an ad is taken down; an old one should
// vanish instead of showing a broken image.
export function Photo({ src, href }: { src: string; href: string }) {
  const [dead, setDead] = useState(false);
  if (dead) return null;
  return (
    <a href={href} className="-mx-4 -mt-4 mb-3 block overflow-hidden rounded-t-2xl bg-[var(--surface-2)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setDead(true)}
        className="aspect-[16/10] w-full object-cover"
      />
    </a>
  );
}
