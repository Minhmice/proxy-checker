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
  Lock,
  Terminal,
  Server,
  AlertCircle,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { login } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import KineticGrid from "@/components/ui/kinetic-grid";
import { cn } from "@/lib/utils";

function playAudioTone(freq: number, type: OscillatorType, duration: number, gainVal: number) {
  try {
    if (typeof window === "undefined" || !("AudioContext" in window)) return;
    const ctx = new window.AudioContext();
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
  {
    tag: "AUTH",
    tagClass: "auth-terminal-tag",
    text: "Control password required for dashboard and proxy operations",
  },
  {
    tag: "SESSION",
    tagClass: "auth-terminal-tag--sync",
    text: "Session cookie valid for 24 hours from sign-in",
  },
  {
    tag: "SECURITY",
    tagClass: "auth-terminal-tag--ok",
    text: "Issued session token uses HttpOnly cookie",
  },
  {
    tag: "AUDIT",
    tagClass: "auth-terminal-tag",
    text: "Operational events and proxy audits recorded to local database",
  },
];

export default function AuthPage() {
  const router = useRouter();
  const { authenticated, setAuthenticated, setPassword } = useAuth();
  const [value, setValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [timeString, setTimeString] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [decryptStage, setDecryptStage] = useState<"idle" | "decrypting" | "verified">("idle");
  const [isShaking, setIsShaking] = useState(false);
  const lastKeyToneRef = useRef(0);
  const pendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

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
    if (errorMessage) {
      setErrorMessage("");
    }
    playKeyClick();
  };

  const triggerShake = () => {
    setIsShaking(true);
    playErrorBuzz();
    setTimeout(() => setIsShaking(false), 340);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (!value.trim()) {
      setErrorMessage("Enter your control password to sign in.");
      triggerShake();
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    pendingRef.current = true;
    setIsPending(true);
    setErrorMessage("");

    try {
      await login(value);
      if (signal.aborted) return;
      setPassword(value);
      setAuthenticated(true);

      const isReduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (isReduced) {
        router.replace("/");
        return;
      }

      setDecryptStage("decrypting");
      playAccessChord();
      await new Promise<void>((resolve) => setTimeout(resolve, 180));
      if (signal.aborted) return;

      setDecryptStage("verified");
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
      if (signal.aborted) return;

      router.replace("/");
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : "";
      const lower = message.toLowerCase();
      if (lower.includes("invalid") || lower.includes("password")) {
        setErrorMessage("Invalid control password. Check password and try again.");
      } else if (error instanceof TypeError) {
        setErrorMessage("Could not reach the server. Check your network connection and try again.");
      } else {
        setErrorMessage("Sign-in request failed. Check server status and try again.");
      }
      triggerShake();
      setDecryptStage("idle");
    } finally {
      if (!signal.aborted) {
        pendingRef.current = false;
        setIsPending(false);
      }
    }
  }

  return (
    <KineticGrid className="auth-page" globalColor="default">
      <div className="auth-split-wrapper">
        <div className="auth-split-grid">
          {/* Left Column: Mission Control & System Guidance */}
          <div className="auth-hero-pane">
            <div>
              <div className="flex items-center gap-3">
                <div className="auth-gate-mark font-mono text-sm font-bold">mP</div>
                <div>
                  <span className="text-base font-bold text-ink tracking-tight block">
                    minhmiceProxy
                  </span>
                  <span className="text-xs font-mono text-slate-400 tracking-wide">
                    9Router Fleet Companion
                  </span>
                </div>
              </div>

              <div className="mt-8 lg:mt-16">
                <h1 className="text-2xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-ink leading-[1.14]">
                  High-throughput proxy fleet orchestration under complete control.
                </h1>
                <p className="mt-4 text-sm sm:text-base text-slate-300 max-w-xl leading-relaxed">
                  Live latency ranking, sub-second route toggling, and automated health verification
                  for 9Router proxy pools in dim control-room conditions.
                </p>
              </div>

              {/* Factual Operational Console Card */}
              <div className="auth-mission-card">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-border-subtle">
                  <div className="flex items-center gap-2">
                    <span className="status-dot status-dot--ok" />
                    <span className="font-mono text-xs font-semibold text-ink uppercase tracking-wider">
                      Control Plane Ready
                    </span>
                  </div>
                  <span className="font-mono text-xs text-slate-400">GATEWAY 127.0.0.1:1300</span>
                </div>

                <div className="auth-mission-metrics">
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">ACCESS SCOPE</span>
                    <span className="auth-mission-metric-v">
                      <ShieldCheck className="size-3.5 text-primary" /> Operator
                    </span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">SESSION LIFETIME</span>
                    <span className="auth-mission-metric-v text-accent-green">
                      <Clock className="size-3.5 text-accent-green" /> 24 Hours
                    </span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">TARGET DAEMON</span>
                    <span className="auth-mission-metric-v">
                      <Server className="size-3.5 text-primary" /> 9Router
                    </span>
                  </div>
                  <div className="auth-mission-metric-cell">
                    <span className="auth-mission-metric-k">SESSION STORE</span>
                    <span className="auth-mission-metric-v">
                      <Lock className="size-3.5 text-accent-green" /> HttpOnly
                    </span>
                  </div>
                </div>

                {/* Session Policy Guidelines */}
                <div className="auth-terminal-box">
                  <div className="auth-terminal-header">
                    <span className="flex items-center gap-1.5">
                      <Terminal className="size-3 text-muted-foreground" /> Session Access
                      Guidelines
                    </span>
                    <span className="text-[10px] text-accent-green font-medium">
                      AUTHENTICATION REQUIRED
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {LOG_ENTRIES.map((entry, idx) => (
                      <div
                        key={idx}
                        className={cn("auth-terminal-line", idx >= 2 && "hidden sm:flex")}
                      >
                        <span className={cn("text-[11px] font-semibold shrink-0", entry.tagClass)}>
                          [{entry.tag}]
                        </span>
                        <span className="auth-terminal-msg text-[11px] truncate text-slate-200">
                          {entry.text}
                        </span>
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
                <span>Session Isolation</span>
              </div>
              <div className="auth-trust-item text-slate-300">
                <Lock className="size-3.5 text-accent-green" />
                <span>Protected Route Management</span>
              </div>
              <div className="auth-trust-item text-slate-300">
                <Server className="size-3.5 text-slate-400" />
                <span>Local Fleet Controller</span>
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
              ) : (
                <div />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleAudio}
                className={cn("auth-audio-toggle", audioEnabled && "is-active")}
                aria-pressed={audioEnabled}
                aria-label={
                  audioEnabled ? "Disable UI synthesized sound" : "Enable UI synthesized sound"
                }
                title={audioEnabled ? "Synthesized sound feedback active" : "Sound muted"}
              >
                {audioEnabled ? (
                  <Volume2 className="size-3 text-primary" />
                ) : (
                  <VolumeX className="size-3 text-muted-foreground" />
                )}
                <span>{audioEnabled ? "AUDIO ON" : "AUDIO OFF"}</span>
              </Button>
            </div>

            <Card className={cn("auth-page-card", isShaking && "is-shaking")}>
              <CardHeader className="pb-4">
                <CardTitle
                  id="auth-page-title"
                  className="text-2xl font-bold tracking-tight text-ink"
                >
                  Authorize Control Plane
                </CardTitle>
                <CardDescription className="text-sm text-slate-300">
                  Enter control password to access proxy fleet routes and settings.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {errorMessage && (
                  <Alert
                    id="auth-error-alert"
                    variant="destructive"
                    className="mb-4 py-2.5 px-3 text-xs"
                    role="alert"
                    aria-live="assertive"
                  >
                    <AlertCircle className="size-4 shrink-0" />
                    <AlertDescription className="text-xs font-medium">
                      {errorMessage}
                    </AlertDescription>
                  </Alert>
                )}

                <form onSubmit={submit} className="auth-gate-form" aria-busy={isPending}>
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
                          disabled={isPending}
                          aria-invalid={Boolean(errorMessage)}
                          aria-describedby={errorMessage ? "auth-error-alert" : undefined}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            onClick={() => setShowPassword((current) => !current)}
                            aria-label={showPassword ? "Hide passphrase" : "Show passphrase"}
                            disabled={isPending}
                          >
                            {showPassword ? <EyeOff /> : <Eye />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                      <div className="auth-entropy-strip" aria-live="polite">
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {value.length === 0
                            ? "Passphrase required"
                            : `${value.length} character${value.length === 1 ? "" : "s"} entered`}
                        </span>
                        <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400">
                          {value.length > 0 ? "INPUT READY" : "EMPTY"}
                        </span>
                      </div>
                    </Field>
                    <Button
                      type="submit"
                      disabled={isPending || decryptStage !== "idle"}
                      className="w-full flex items-center justify-between mt-2"
                    >
                      {isPending ? (
                        <span className="flex items-center gap-2">
                          <ShieldCheck className="size-4 animate-spin text-primary" />
                          <span>Verifying password...</span>
                        </span>
                      ) : decryptStage === "idle" ? (
                        <>
                          <span>Authorize Session</span>
                          <div className="flex items-center gap-1.5 ml-auto">
                            <span className="text-[10px] font-mono opacity-65 tracking-wider hidden sm:inline">
                              [↵ ENTER]
                            </span>
                            <ArrowRight data-icon="inline-end" className="size-4" />
                          </div>
                        </>
                      ) : decryptStage === "decrypting" ? (
                        <span className="flex items-center gap-2">
                          <ShieldCheck className="size-4 animate-spin text-primary" />
                          <span>Establishing session...</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2 text-emerald-400">
                          <Check className="size-4" />
                          <span>Session granted</span>
                        </span>
                      )}
                    </Button>
                  </FieldGroup>
                </form>
                <p className="auth-gate-footnote font-mono text-xs opacity-75 mt-4">
                  Local session verification · Valid for 24 hours from sign-in
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </KineticGrid>
  );
}
