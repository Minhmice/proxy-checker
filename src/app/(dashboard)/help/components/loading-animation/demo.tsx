"use client";

import { LoadingAnimation } from "@/components/ui/loading-animation";

// Controls for the demo panel (literal values only).
export const settings = {
  name: "Asha Iyer",
  cta: "Create Now",
  loadingLabel: "Setting up your desk",
  size: 0.5,
  spread: 1,
  showReveal: true,
  autoplay: true,
};

// Every prop falls back to its default, so the demo also renders before any control value arrives.
export default function Demo({
  name = settings.name,
  cta = settings.cta,
  loadingLabel = settings.loadingLabel,
  size = settings.size,
  spread = settings.spread,
  showReveal = settings.showReveal,
  autoplay = settings.autoplay,
}: Partial<typeof settings>) {
  return (
    <LoadingAnimation
      name={name}
      cta={cta}
      loadingLabel={loadingLabel}
      size={size}
      spread={spread}
      showReveal={showReveal}
      autoplay={autoplay}
    />
  );
}
