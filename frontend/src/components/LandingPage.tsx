'use client';

import { HeroSection } from './ui/hero-section';

interface LandingPageProps {
  onGetStarted: () => void;
}

export default function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <HeroSection onGetStarted={onGetStarted} />
  );
}
