import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function StubPage({ title }: { title: string }) {
  return (
    <Card className="stub-page">
      <CardHeader>
        <h1>{title}</h1>
      </CardHeader>
      <CardContent>
        <Badge variant="secondary">Coming soon</Badge>
      </CardContent>
    </Card>
  );
}
