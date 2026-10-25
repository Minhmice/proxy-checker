"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  ExternalLink,
  Layers,
  Palette,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { BorderBeam } from "@/components/ui/border-beam";
import { Spotlight } from "@/components/ui/spotlight";
import { TextAnimate } from "@/components/ui/text-animate";
import { CobeGlobe } from "@/components/ui/cobe-globe";
import { CodeBlock } from "@/components/ui/code-block";
import {
  HaloCard,
  HaloCardHeader,
  HaloCardTitle,
  HaloCardDescription,
  HaloCardAction,
  HaloCardContent,
  HaloCardFooter,
  HaloCardButton,
  type HaloThemeVariant,
} from "@/components/ui/halo-card";
import { cn } from "@/lib/utils";
export default function ComponentShowcasePage() {
  const [beamActive, setBeamActive] = useState(true);
  const [haloVariant, setHaloVariant] = useState<HaloThemeVariant>("flame");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  function copyCode(key: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  return (
    <main className="max-w-5xl 3xl:max-w-6xl mx-auto space-y-8 p-4 sm:p-6 text-foreground">
      {/* Header with Back button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-8 px-2 -ml-2 text-muted-foreground"
            >
              <Link href="/help">
                <ArrowLeft className="size-4 mr-1" />
                Help
              </Link>
            </Button>
            <Badge variant="outline" className="font-mono text-xs">
              DESIGN SYSTEM v2.0
            </Badge>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Frontend Component Ecosystem
          </h1>
          <p className="text-xs text-muted-foreground">
            Integration reference for 21st.dev, Magic UI, Aceternity UI, and Cult UI composed on
            shadcn/ui.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings">System Settings</Link>
          </Button>
        </div>
      </div>

      {/* Hero Showcase Card with Aceternity Spotlight + Cult UI TextAnimate */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-6 sm:p-8 shadow-sm">
        <Spotlight
          className="-top-40 left-0 md:left-60 md:-top-20"
          fill="rgba(255, 91, 34, 0.18)"
        />
        <div className="relative z-10 max-w-2xl space-y-3">
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="bg-primary/10 text-primary border-primary/20 text-xs"
            >
              <Sparkles className="size-3 mr-1" />
              Aceternity & Cult UI Preview
            </Badge>
          </div>
          <TextAnimate
            text="Control Room Component Showcase"
            type="fadeInUp"
            className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground mt-1"
          />
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
            Every library is adapted to the project&apos;s deep navy control-room theme (`oklch`
            tokens), preserving shadcn accessibility and operational scanability without performance
            degradation.
          </p>
        </div>
      </div>

      {/* Interactive Tabs for each Library */}
      <Tabs defaultValue="magic-ui" className="space-y-6">
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full h-auto p-1.5 bg-surface-raised border border-border rounded-xl gap-1 shadow-sm">
          <TabsTrigger
            value="magic-ui"
            className="flex items-center justify-center gap-2 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
          >
            <Zap className="size-4 shrink-0" />
            <span>Magic UI</span>
          </TabsTrigger>

          <TabsTrigger
            value="aceternity"
            className="flex items-center justify-center gap-2 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
          >
            <Sparkles className="size-4 shrink-0" />
            <span>Aceternity UI</span>
          </TabsTrigger>

          <TabsTrigger
            value="cult-ui"
            className="flex items-center justify-center gap-2 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
          >
            <Palette className="size-4 shrink-0" />
            <span>Cult UI</span>
          </TabsTrigger>

          <TabsTrigger
            value="21st-dev"
            className="flex items-center justify-center gap-2 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
          >
            <Layers className="size-4 shrink-0" />
            <span>21st.dev</span>
          </TabsTrigger>
        </TabsList>

        {/* 1. MAGIC UI TAB */}
        <TabsContent value="magic-ui" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Live Interactive Card */}
            <Card className="relative overflow-hidden border-border bg-card shadow-sm flex flex-col justify-between">
              {beamActive && (
                <BorderBeam
                  size={80}
                  duration={6}
                  delay={0}
                  colorFrom="#FF6633"
                  colorTo="#FF3500"
                  borderWidth={1.5}
                />
              )}
              <CardHeader className="space-y-1">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    @magicui/border-beam
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="toggle-beam"
                      className="text-xs text-muted-foreground cursor-pointer"
                    >
                      Effect {beamActive ? "Active" : "Paused"}
                    </Label>
                    <Switch id="toggle-beam" checked={beamActive} onCheckedChange={setBeamActive} />
                  </div>
                </div>
                <CardTitle className="text-base font-semibold pt-2">Border Beam Accent</CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  A smooth gradient border pulse traveling around cards. Ideal for highlighted sync
                  cycles or active inspection states.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  • <strong>Stack:</strong> React 19 + Tailwind v4 + `motion/react`.
                </p>
                <p>
                  • <strong>Theme integration:</strong> Colors bound directly to `--primary` (flame
                  orange) and Obsidian Flame palette tokens.
                </p>
              </CardContent>
              <CardFooter className="border-t border-border/50 py-3 bg-muted/10 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Component: `src/components/ui/border-beam.tsx`
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => copyCode("beam", "npx shadcn@latest add @magicui/border-beam")}
                >
                  {copiedKey === "beam" ? (
                    <Check className="size-3 mr-1 text-emerald-400" />
                  ) : (
                    <Copy className="size-3 mr-1" />
                  )}
                  {copiedKey === "beam" ? "Copied" : "Copy Install"}
                </Button>
              </CardFooter>
            </Card>

            {/* Documentation & Usage Guidance */}
            <Card className="border-border bg-card shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Terminal className="size-4 text-primary" />
                  Magic UI Guidelines & Skills
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Rules and installed skills for Magic UI in this codebase.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5">
                  <div className="font-semibold text-foreground">Installed Skill: `magic-ui`</div>
                  <p className="text-muted-foreground leading-relaxed">
                    Accessible via `.agents/skills/magic-ui`. Use it when adding badges, animated
                    buttons, or micro-accents.
                  </p>
                </div>
                <div className="space-y-1 font-mono text-[11px] bg-black/40 rounded border p-2.5 text-slate-300">
                  <div className="text-muted-foreground"># Registry installation command</div>
                  <div>npx shadcn@latest add @magicui/&lt;component-name&gt;</div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  <strong>Guardrail:</strong> Maximum 1 motion accent per viewport. Never apply
                  infinite loops across entire proxy tables or input fields.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 2. ACETERNITY UI TAB */}
        <TabsContent value="aceternity" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="relative overflow-hidden border-border bg-card shadow-sm flex flex-col justify-between">
              <Spotlight className="-top-20 left-10" fill="oklch(0.78 0.18 145 / 0.15)" />
              <CardHeader>
                <Badge variant="outline" className="w-fit font-mono text-[10px]">
                  Aceternity / Spotlight
                </Badge>
                <CardTitle className="text-base font-semibold pt-2">
                  Ambient Spotlight Glow
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Subtle conic illumination layer adding depth to hero cards, system diagnostics,
                  and major overview panels.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  • <strong>CSS Keyframes:</strong> Smooth entry animation declared in `globals.css`
                  with `@keyframes spotlight`.
                </p>
                <p>
                  • <strong>Reduced Motion:</strong> Automatically silenced when
                  `prefers-reduced-motion: reduce` is detected.
                </p>
              </CardContent>
              <CardFooter className="border-t border-border/50 py-3 bg-muted/10 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  File: `src/components/ui/spotlight.tsx`
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() =>
                    copyCode(
                      "spotlight",
                      "npx shadcn@latest add https://ui.aceternity.com/registry/spotlight.json",
                    )
                  }
                >
                  {copiedKey === "spotlight" ? (
                    <Check className="size-3 mr-1 text-emerald-400" />
                  ) : (
                    <Copy className="size-3 mr-1" />
                  )}
                  {copiedKey === "spotlight" ? "Copied" : "Copy Install"}
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-border bg-card shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Terminal className="size-4 text-primary" />
                  Aceternity UI Installation Policy
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Direct JSON registry endpoints for clean shadcn adoption.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <p className="text-muted-foreground leading-relaxed">
                  Aceternity UI components can be installed directly through shadcn using official
                  registry URLs:
                </p>
                <div className="space-y-1 font-mono text-[11px] bg-black/40 rounded border p-2.5 text-slate-300">
                  <div className="text-muted-foreground"># Registry URL pattern</div>
                  <div>
                    npx shadcn@latest add https://ui.aceternity.com/registry/&lt;name&gt;.json
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1 text-muted-foreground">
                  <span className="font-semibold text-foreground">Operational Rule:</span> No 3D
                  canvas cards, cursor-following canvas trails, or sticky tilt effects on
                  operational screens.
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 3. CULT UI TAB */}
        <TabsContent value="cult-ui" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Live Interactive HaloCard Showcase */}
            <div className="md:col-span-2 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      @cult-ui/halo-card
                    </Badge>
                    <span className="text-xs text-primary font-semibold">
                      Obsidian Flame Adaptive
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-foreground mt-1">
                    Halo Card with Border Trail & Ambient Rim
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Composable card with moving border trail, bottom glowing ambient blobs, and
                    frosted glass.
                  </p>
                </div>
                {/* Variant selector */}
                <div className="flex items-center gap-1.5 p-1 bg-surface-raised border border-border rounded-lg text-xs self-start sm:self-auto">
                  {(["flame", "amber", "emerald", "rose"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setHaloVariant(v)}
                      className={cn(
                        "px-2.5 py-1 rounded capitalize font-medium transition-all cursor-pointer",
                        haloVariant === v
                          ? "bg-primary text-white shadow-xs"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/5",
                      )}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                <HaloCard
                  variant={haloVariant}
                  aria-label="Interactive Halo Card Demo"
                  className="w-full"
                >
                  <HaloCardHeader>
                    <HaloCardTitle>Autonomous Quota Balancer</HaloCardTitle>
                    <HaloCardDescription>
                      Dual-core Antigravity rotation engine dynamically redistributes tokens when
                      Gemini session quota dips below 20%.
                    </HaloCardDescription>
                    <HaloCardAction>
                      <HaloCardButton
                        glowVariant={haloVariant}
                        variant="secondary"
                        size="icon"
                        aria-label="Configuration"
                      >
                        <Zap className="size-4" />
                      </HaloCardButton>
                    </HaloCardAction>
                  </HaloCardHeader>

                  <HaloCardContent>
                    <p className="text-sm text-foreground/90 leading-relaxed">
                      Header, content, and footer slots share the same gradient rim and frosted
                      surface adapted to the Obsidian Flame system.
                    </p>
                    <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                      <span className="size-2 rounded-full bg-emerald-400" />
                      <span>Cluster Status: Healthy (3/3 active routes)</span>
                    </div>
                  </HaloCardContent>

                  <HaloCardFooter className="justify-between gap-3">
                    <HaloCardButton glowVariant={haloVariant} variant="secondary">
                      Dismiss
                    </HaloCardButton>
                    <HaloCardButton glowVariant={haloVariant} variant="primary">
                      Trigger Sync
                    </HaloCardButton>
                  </HaloCardFooter>
                </HaloCard>

                {/* Minimal Layout Variant */}
                <HaloCard
                  variant={haloVariant}
                  aria-label="Minimal Halo Card Demo"
                  className="w-full"
                >
                  <HaloCardHeader>
                    <HaloCardTitle>Minimal Telemetry Stream</HaloCardTitle>
                    <HaloCardDescription>
                      Title and description layout without content or footer slots. Moving border
                      trail activates on hover and focus.
                    </HaloCardDescription>
                  </HaloCardHeader>
                  <div className="mt-4 pt-4 border-t border-border-subtle/60 flex items-center justify-between text-xs text-muted-foreground font-mono">
                    <span>Active Theme:</span>
                    <span className="capitalize font-semibold text-primary">{haloVariant}</span>
                  </div>
                </HaloCard>
              </div>
            </div>

            <Card className="border-border bg-card shadow-sm flex flex-col justify-between">
              <CardHeader>
                <Badge variant="outline" className="w-fit font-mono text-[10px]">
                  cult-ui / text-animate
                </Badge>
                <CardTitle className="text-base font-semibold pt-2">
                  Staggered Text Animate
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Polished entrance typography based on Vercel/Linear motion physics.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="p-4 rounded-lg bg-surface-raised/60 border border-border">
                  <TextAnimate
                    text="Reliable · Measurable · Real-time"
                    type="fadeInUp"
                    className="text-sm font-semibold text-primary"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Character-level spring animation with zero layout thrashing.
                </p>
              </CardContent>
              <CardFooter className="border-t border-border/50 py-3 bg-muted/10 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  File: `src/components/ui/text-animate.tsx`
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() =>
                    copyCode(
                      "cult",
                      "npx shadcn@latest add https://www.cult-ui.com/r/text-animate.json",
                    )
                  }
                >
                  {copiedKey === "cult" ? (
                    <Check className="size-3 mr-1 text-emerald-400" />
                  ) : (
                    <Copy className="size-3 mr-1" />
                  )}
                  {copiedKey === "cult" ? "Copied" : "Copy Install"}
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-border bg-card shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Palette className="size-4 text-primary" />
                  Cult UI Skills Installed
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Officially verified skills from `nolly-studio/cult-ui`.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="space-y-2">
                  <div className="p-2.5 rounded border border-border/60 bg-muted/20">
                    <span className="font-semibold text-foreground">`components-build`</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Design system component building, accessibility invariants, and variant
                      patterns.
                    </p>
                  </div>
                  <div className="p-2.5 rounded border border-border/60 bg-muted/20">
                    <span className="font-semibold text-foreground">`frontend-design`</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Craft doctrine for surfaces, typography hierarchy, concentric radius, and
                      clean motion.
                    </p>
                  </div>
                  <div className="p-2.5 rounded border border-border/60 bg-muted/20">
                    <span className="font-semibold text-foreground">
                      `fixing-motion-performance`
                    </span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Prevents layout thrashing, audits will-change, and ensures silky 60fps
                      animations.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 4. 21ST.DEV TAB */}
        <TabsContent value="21st-dev" className="space-y-6">
          <Card className="border-border bg-card shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <Layers className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">21st.dev Magic MCP Integration</CardTitle>
                    <CardDescription>
                      AI component catalog search and automated code injection directly inside your
                      IDE.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="secondary" className="text-xs">
                  Skill: `21st-ui`
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                  <div className="font-semibold text-foreground">1. Catalog Search</div>
                  <p className="text-muted-foreground text-[11px]">
                    Access 10,000+ shadcn/Tailwind components via natural language prompt.
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                  <div className="font-semibold text-foreground">2. Direct Code Injection</div>
                  <p className="text-muted-foreground text-[11px]">
                    Fetch component code, styles, and dependencies without leaving the editor.
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                  <div className="font-semibold text-foreground">3. SVG Logo Finder</div>
                  <p className="text-muted-foreground text-[11px]">
                    Extract pure SVG React components for popular tech brands (`search_logo`).
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <span className="font-semibold text-foreground">How to configure 21st MCP:</span>
                <CodeBlock
                  title="mcp.json snippet"
                  language="json"
                  code={`{
  "mcpServers": {
    "21st": {
      "url": "https://21st.dev/api/mcp",
      "headers": { "x-api-key": "<YOUR_API_KEY>" }
    }
  }
}`}
                />
              </div>

              <Separator />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                <div className="space-y-1.5">
                  <span className="font-semibold text-foreground">
                    Interactive Global Telemetry (COBE Globe)
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Lightweight 5KB WebGL canvas rendering global proxy coordinates with momentum
                    rotation physics and reduced-motion fallback.
                  </p>
                  <div className="flex items-center gap-2 pt-1 font-mono text-[10px] text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Active clusters: US, SG, VN, EU</span>
                  </div>
                </div>
                <div className="flex justify-center p-2 rounded-xl bg-black/40 border border-border/60">
                  <CobeGlobe
                    size={200}
                    markers={[
                      { location: [37.7595, -122.4367], size: 0.06 },
                      { location: [1.3521, 103.8198], size: 0.08 },
                      { location: [21.0285, 105.8542], size: 0.08 },
                      { location: [52.52, 13.405], size: 0.05 },
                    ]}
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="border-t border-border/50 py-3 bg-muted/10 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                Installed skill: `.agents/skills/21st-ui/SKILL.md`
              </span>
              <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                <a href="https://21st.dev/mcp" target="_blank" rel="noreferrer">
                  Get Free API Key <ExternalLink className="size-3 ml-1" />
                </a>
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}
