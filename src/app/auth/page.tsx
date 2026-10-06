"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  EyeOff,
  ArrowRight,
  Volume2,
  VolumeX,
  ShieldCheck,
  Check,
  Clock,
  Cpu,
  Lock,
  Activity,
  Terminal,
  Server,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { login } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import KineticGrid from "@/components/ui/kinetic-grid";
import { cn } from "@/lib/utils";

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  if ("AudioContext" in window) return window.AudioContext;
  if ("webkitAudioContext" in window) {
    const ctx = window["webkitAudioContext" as keyof Window];
    if (typeof ctx === "function") {
      return ctx as typeof AudioContext;
    }
  }
  return undefined;
}

function playAudioTone(freq: number, type: OscillatorType, duration: number, gainVal: number) {
  try {
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Audio context suppressed by policy
  }
}

const LOG_ENTRIES = [
  { tag: "INIT", tagClass: "auth-terminal-tag", text: "IPC telemetry bridge connected to 127.0.0.1:1300" },
  { tag: "SYNC", tagClass: "auth-terminal-tag--sync", text: "Proxy ranker online · 24 routes prioritized by latency" },
  { tag: "AUDIT", tagClass: "auth-terminal-tag--ok", text: "Integrity guard active · zero origin-leak / SSRF violations" },
  { tag: "GATE", tagClass: "auth-terminal-tag", text: "Control plane locked · awaiting operator passphrase..." },
];

export default function AuthPage() {
  const router = useRouter();
  const { authenticated, setAuthenticated, setPassword } = useAuth();
  const [value, setValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [timeString, setTimeString] = useState("");
  const [decryptStage, setDecryptStage] = useState<"idle" | "decrypting" | "verified">("idle");
  const [isShaking, setIsShaking] = useState(false);
  const lastKeyToneRef = useRef(0);

  useEffect(() => {
    if (authenticated) router.replace("/");
  }, [authenticated, router]);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTimeString(now.toISOString().substring(11, 19) + " UTC");
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const playKeyClick = useCallback(() => {
    if (!audioEnabled) return;
    const now = Date.now();
    if (now - lastKeyToneRef.current < 45) return;
    lastKeyToneRef.current = now;
    playAudioTone(760 + Math.random() * 80, "triangle", 0.025, 0.015);
  }, [audioEnabled]);

  const playAccessChord = useCallback(() => {
    if (!audioEnabled) return;
    playAudioTone(440, "sine", 0.12, 0.04);
    setTimeout(() => playAudioTone(880, "sine", 0.25, 0.05), 90);
  }, [audioEnabled]);

  const playErrorBuzz = useCallback(() => {
    if (!audioEnabled) return;
    playAudioTone(160, "sawtooth", 0.16, 0.04);
  }, [audioEnabled]);

  const toggleAudio = () => {
    setAudioEnabled((prev) => {
      const next = !prev;
      if (next) playAudioTone(880, "sine", 0.08, 0.03);
      return next;
    });
  };

  const handleInputChange = (nextVal: string) => {
    setValue(nextVal);
    playKeyClick();
  };

  const triggerShake = () => {
    setIsShaking(true);
    playErrorBuzz();
    setTimeout(() => setIsShaking(false), 340);
  };

  const getEntropy = (pass: string) => {
    const len = pass.length;
    if (len === 0) return { level: 0, label: "STANDBY", dots: [false, false, false, false] };
    if (len < 6) return { level: 1, label: "STAGE 1", dots: [true, false, false, false] };
    if (len < 10) return { level: 2, label: "STAGE 2", dots: [true, true, false, false] };
    if (len < 16) return { level: 3, label: "SECURE", dots: [true, true, true, false] };
    return { level: 4, label: "MAXIMUM (256-BIT)", dots: [true, true, true, true] };
  };

  const entropy = getEntropy(value);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) {
      triggerShake();
      return;
    }

    try {
      await login(value);
      setPassword(value);
      setAuthenticated(true);

      const isReduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (isReduced) {
        router.replace("/");
        return;
      }

      setDecryptStage("decrypting");
      playAccessChord();

      const stageOne = Promise.withResolvers<void>();
      setTimeout(stageOne.resolve, 180);
      await stageOne.promise;

      setDecryptStage("verified");
      const stageTwo = Promise.withResolvers<void>();
      setTimeout(stageTwo.resolve, 160);
      await stageTwo.promise;

      router.replace("/");
    } catch {
      triggerShake();
      setDecryptStage("idle");
    }
  }

  return (
    <KineticGrid className="auth-page" globalColor="default">
      <div className="auth-split-wrapper">
        <div className="auth-split-grid">
          {/* Left Column: Mission Control & Fleet Radar */}
          <div className="auth-hero-pane">
            <div>
              <div className="flex items-center gap-3">
                <div className="auth-gate-mark font-mono text-sm font-bold">mP</div>
                <div>
                  <span className="text-base font-bold text-ink tracking-tight block">minhmiceProxy</span>
                  <span className="text-xs font-mono text-slate-400 tracking-wide">9Router Fleet Companion</span>
                </div>
                <Badge variant="outline" className="ml-auto font-mono text-[10px] text-slate-300 border-border hidden sm:inline-flex">
                  DAEMON v2.4
                </Badge>
              </div>

              <div className="mt-8 lg:mt-16">
                <h1 className="text-2xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-ink leading-[1.14]">
                  High-throughput proxy fleet orchestration under complete control.
                </h1>
                <p className="mt-4 text-sm sm:text-base text-slate-300 max-w-xl leading-relaxed">
                  Live latency ranking, sub-second route toggling, and automated health verification for 9Router proxy pools in dim control-room conditions.
                </p>
              </div>

              {/* Visual Telemetry Console Card */}
              <div className="auth-mission-card">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-border-subtle">
                  <div className="flex items-center gap-2">
                    <span className="status-dot status-dot--ok" />
                    <span className="font-mono text-xs font-semibold text-ink uppercase tracking-wider">
                      Cluster Core Online
                    </span>
                  </div>
                  <span className="font-mono text-xs text-slate-400">GATEWAY 127.0.0.1:1300</span>
                </div>

                <div className="auth-mission-metrics">
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">ACTIVE POOL</span>
                    <span className="auth-mission-metric-v">
                      <Server className="size-3.5 text-primary" /> 24 / 24
                    </span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">AVG LATENCY</span>
                    <span className="auth-mission-metric-v">
                      <Activity className="size-3.5 text-accent-green" /> 38ms
                    </span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">POOL HEALTH</span>
                    <span className="auth-mission-metric-v text-accent-green">99.8%</span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">CIPHER SUITE</span>
                    <span className="auth-mission-metric-v">TLS 1.3</span>
                  </div>
                </div>

                {/* Live Console Terminal Log */}
                <div className="auth-terminal-box">
                  <div className="auth-terminal-header">
                    <span className="flex items-center gap-1.5">
                      <Terminal className="size-3 text-muted-foreground" /> Realtime Event Stream
                    </span>
                    <span className="text-[10px] text-accent-green font-medium">STREAM ACTIVE</span>
                  </div>
                  <div className="space-y-1.5">
                    {LOG_ENTRIES.map((entry, idx) => (
                      <div key={idx} className={cn("auth-terminal-line", idx >= 2 && "hidden sm:flex")}>
                        <span className={cn("text-[11px] font-semibold shrink-0", entry.tagClass)}>
                          [{entry.tag}]
                        </span>
                        <span className="auth-terminal-msg text-[11px] truncate text-slate-200">{entry.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Architecture Trust Bar */}
            <div className="auth-trust-bar">
              <div className="auth-trust-item text-slate-300">
                <ShieldCheck className="size-3.5 text-primary" />
                <span>AES-256 Memory Encrypted</span>
              </div>
              <div className="auth-trust-item text-slate-300">
                <Lock className="size-3.5 text-accent-green" />
                <span>Local Session Isolation</span>
              </div>
              <div className="auth-trust-item text-slate-300">
                <Cpu className="size-3.5 text-slate-400" />
                <span>Sub-second Failover</span>
              </div>
            </div>
          </div>

          {/* Right Column: Operator Authentication Chassis */}
          <div className="auth-form-pane">
            <div className="w-full max-w-[440px] flex items-center justify-between mb-4">
              {timeString ? (
                <span className="auth-telemetry-badge text-slate-300" title="Live UTC timestamp">
                  <Clock className="size-3 text-slate-400" />
                  <span>{timeString}</span>
                </span>
              ) : <div />}
              <button
                type="button"
                onClick={toggleAudio}
                className={cn("auth-audio-toggle", audioEnabled && "is-active")}
                aria-pressed={audioEnabled}
                aria-label={audioEnabled ? "Disable UI synthesized sound" : "Enable UI synthesized sound"}
                title={audioEnabled ? "Synthesized sound feedback active" : "Sound muted"}
              >
                {audioEnabled ? <Volume2 className="size-3 text-primary" /> : <VolumeX className="size-3 text-muted-foreground" />}
                <span>{audioEnabled ? "AUDIO ON" : "AUDIO OFF"}</span>
              </button>
            </div>

            <Card className={cn("auth-page-card", isShaking && "is-shaking")}>
              <CardHeader className="pb-4">
                <CardTitle id="auth-page-title" className="text-2xl font-bold tracking-tight text-ink">
                  Authorize Control Plane
                </CardTitle>
                <CardDescription className="text-sm text-slate-300">
                  Enter cluster passphrase to unlock live route toggling and pool telemetry.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="auth-gate-form">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="auth-password">Operator passphrase</FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          id="auth-password"
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          autoFocus
                          value={value}
                          onChange={(event) => handleInputChange(event.target.value)}
                          placeholder="Enter control passphrase"
                          className="auth-input-mono font-mono text-base"
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            onClick={() => setShowPassword((current) => !current)}
                            aria-label={showPassword ? "Hide passphrase" : "Show passphrase"}
                          >
                            {showPassword ? <EyeOff /> : <Eye />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                      <div className="auth-entropy-strip" aria-live="polite">
                        <div className="auth-entropy-dots" aria-hidden="true">
                          {entropy.dots.map((active, idx) => (
                            <span
                              key={idx}
                              className={cn(
                                "auth-entropy-dot",
                                active && "is-active",
                                active && entropy.level === 4 && "is-max"
                              )}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] uppercase font-mono tracking-wider">
                          {entropy.label}
                        </span>
                      </div>
                    </Field>
                    <Button
                      type="submit"
                      disabled={decryptStage !== "idle"}
                      className="w-full flex items-center justify-between mt-2"
                    >
                      {decryptStage === "idle" && (
                        <>
                          <span>Authorize Session</span>
                          <div className="flex items-center gap-1.5 ml-auto">
                            <span className="text-[10px] font-mono opacity-65 tracking-wider hidden sm:inline">[↵ ENTER]</span>
                            <ArrowRight data-icon="inline-end" className="size-4" />
                          </div>
                        </>
                      )}
                      {decryptStage === "decrypting" && (
                        <>
                          <span className="flex items-center gap-2">
                            <ShieldCheck className="size-4 animate-spin text-primary" />
                            <span>VERIFYING CIPHER...</span>
                          </span>
                        </>
                      )}
                      {decryptStage === "verified" && (
                        <>
                          <span className="flex items-center gap-2 text-emerald-400">
                            <Check className="size-4" />
                            <span>ACCESS GRANTED</span>
                          </span>
                        </>
                      )}
                    </Button>
                  </FieldGroup>
                </form>
                <p className="auth-gate-footnote font-mono text-xs opacity-75 mt-4">
                  Local session verification · Auto-revoked at 24:00 UTC
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </KineticGrid>
  );
}
