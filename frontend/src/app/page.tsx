"use client";

import { useRouter } from "next/navigation";
import LandingPage from "@/components/LandingPage";

export default function Home() {
  const router = useRouter();

  const handleGetStarted = () => {
    router.push('/setup');
  };

  return <LandingPage onGetStarted={handleGetStarted} />;
}
