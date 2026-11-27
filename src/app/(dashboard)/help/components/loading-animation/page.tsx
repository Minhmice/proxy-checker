import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Demo from "./demo";

export default function LoadingAnimationPage() {
  return (
    <section
      aria-label="Pixel loader demo"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background [--la-viewport:max(20rem,calc(100dvh-11rem))]"
    >
      <header className="flex h-14 shrink-0 items-center border-b border-border px-3 sm:px-6">
        <Button asChild variant="ghost" className="min-h-11">
          <Link href="/help/components">
            <ArrowLeft data-icon="inline-start" />
            UI Components
          </Link>
        </Button>
      </header>
      <Demo autoplay={false} />
    </section>
  );
}
