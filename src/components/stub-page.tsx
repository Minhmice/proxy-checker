import Link from "next/link";
import { LayoutDashboard, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

interface StubPageProps {
  title: string;
  description?: string;
}

export function StubPage({ title, description }: StubPageProps) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {description ?? "This feature is not implemented in this application."}
          </p>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Use navigation links to return to active operational views.
          </p>
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row gap-2">
          <Button asChild variant="outline" className="min-h-[44px] flex-1">
            <Link href="/" className="inline-flex items-center justify-center gap-2">
              <LayoutDashboard className="size-4" />
              <span>Overview</span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-[44px] flex-1">
            <Link href="/proxies" className="inline-flex items-center justify-center gap-2">
              <Network className="size-4" />
              <span>Proxies</span>
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
