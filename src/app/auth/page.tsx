"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { login } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import DitherFrame from "@/components/ui/dither-frame";
import { DitherCard } from "@/components/dithercn/dither-card";
import { Fire } from "@/components/dithercn/fire";
import { SpotifyPlayer } from "@/components/spotify-player";
import { cn } from "@/lib/utils";

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Stagger index for the entrance animations defined in dashboard-shell.css. */
const step = (index: number) => ({ "--i": index }) as CSSProperties;

export default function AuthPage() {
  const router = useRouter();
  const { authenticated, setAuthenticated, setPassword } = useAuth();
  const [value, setValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [timeString, setTimeString] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [decryptStage, setDecryptStage] = useState<"idle" | "decrypting" | "verified">("idle");
  const [isShaking, setIsShaking] = useState(false);
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
      setTimeString(`${new Date().toISOString().substring(11, 19)} UTC`);
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleInputChange = (nextVal: string) => {
    setValue(nextVal);
    if (errorMessage) {
      setErrorMessage("");
    }
  };

  const triggerShake = () => {
    setIsShaking(true);
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
      await delay(180);
      if (signal.aborted) return;

      setDecryptStage("verified");
      await delay(160);
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

  const opening = decryptStage !== "idle";

  return (
    <DitherFrame intensity={0.12}>
      <main className="mx-auto grid min-h-dvh w-full max-w-[1600px] grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-4 lg:p-4">
        <DitherCard
          glow="top-right"
          color="--primary"
          reach={320}
          strength={0.35}
          radius={16}
          className="relative isolate flex min-h-[44dvh] flex-col overflow-hidden lg:col-start-2 lg:row-start-1 lg:min-h-0"
        >
          <Fire
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%]"
            height={opening ? 1 : 0.72}
            scale={1.5}
            wind={-0.15}
            embers={0.4}
            intensity={opening ? 0.9 : 0.6}
            palette={["transparent", "--dither-ink", "--primary"]}
          />
          <div className="relative z-10 flex flex-1 flex-col gap-8 p-6 sm:p-8 lg:p-12">
            <div className="auth-rise flex items-center gap-3" style={step(0)}>
              <div className="flame-logo-core grid size-9 place-items-center rounded-[10px] bg-primary font-mono text-xs font-bold text-primary-foreground">
                <span className="relative z-10">mP</span>
              </div>
              <span className="text-sm font-semibold tracking-tight">minhmiceProxy</span>
            </div>

            <div className="my-auto flex max-w-[46rem] flex-col gap-6 pb-[16%] lg:pb-[18%]">
              <h1 className="text-[clamp(2.25rem,4.3vw,4.25rem)] font-semibold leading-[1.06] tracking-[-0.03em]">
                <span className="auth-line">
                  <span style={step(0)}>Two accounts live.</span>
                </span>
                <span className="auth-line text-muted-foreground">
                  <span style={step(1)}>One verified handoff.</span>
                </span>
              </h1>
              <p
                className="auth-rise max-w-[44ch] text-sm leading-relaxed text-muted-foreground sm:text-base"
                style={step(3)}
              >
                9Router quota and token telemetry for Antigravity and Codex. An account is switched
                off only after its replacement is confirmed active.
              </p>
            </div>
          </div>
        </DitherCard>

        <section
          aria-labelledby="auth-title"
          className="flex min-w-0 flex-col px-3 pt-6 pb-4 sm:px-6 lg:col-start-1 lg:row-start-1 lg:px-10 lg:py-10"
        >
          <div className="auth-rise flex items-center justify-between gap-3" style={step(1)}>
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              title="Live UTC timestamp"
            >
              {timeString || "\u00a0"}
            </span>
          </div>

          <SpotifyPlayer
            className="auth-rise order-last mt-8 w-full max-w-[26rem] lg:order-none"
            style={step(2)}
          />

          <div className="min-h-10 flex-1 lg:min-h-24" aria-hidden="true" />

          <div
            className={cn("flex w-full max-w-[26rem] flex-col gap-8", isShaking && "auth-shake")}
          >
            <div className="auth-rise flex flex-col gap-2" style={step(2)}>
              <h2 id="auth-title" className="text-2xl font-semibold tracking-tight">
                Sign in
              </h2>
              <p className="text-sm text-muted-foreground">
                Enter the control password to open the console.
              </p>
            </div>

            {errorMessage && (
              <Alert
                id="auth-error-alert"
                className="border-destructive px-3 py-2.5 text-xs"
                role="alert"
                aria-live="assertive"
              >
                <AlertCircle className="size-4 shrink-0 text-destructive" />
                <AlertDescription className="text-xs font-medium text-card-foreground">
                  {errorMessage}
                </AlertDescription>
              </Alert>
            )}

            <form onSubmit={submit} aria-busy={isPending}>
              <FieldGroup className="gap-8">
                <Field className="auth-rise" style={step(3)}>
                  <FieldLabel htmlFor="auth-password">Control password</FieldLabel>
                  <InputGroup className="auth-underline h-14 rounded-none border-0 border-b border-muted-foreground/50 bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                    <InputGroupInput
                      id="auth-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={value}
                      onChange={(event) => handleInputChange(event.target.value)}
                      className="auth-input-mono h-14 px-0 font-mono text-lg"
                      disabled={isPending || opening}
                      aria-invalid={Boolean(errorMessage)}
                      aria-describedby={errorMessage ? "auth-error-alert" : undefined}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        type="button"
                        variant="plain"
                        size="icon-sm"
                        className="size-11 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowPassword((current) => !current)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        disabled={isPending || opening}
                      >
                        {showPassword ? <EyeOff strokeWidth={1.5} /> : <Eye strokeWidth={1.5} />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>

                <div className="auth-rise" style={step(4)}>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={isPending || opening}
                    className="group/cta min-h-11 gap-3 pr-2 pl-5"
                  >
                    {decryptStage === "verified" ? (
                      <>
                        <span>Signed in</span>
                        <span className="grid size-7 place-items-center rounded-full bg-black/15">
                          <Check className="size-4" strokeWidth={2} />
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          {isPending
                            ? "Checking password"
                            : decryptStage === "decrypting"
                              ? "Opening session"
                              : "Sign in"}
                        </span>
                        <span className="grid size-7 place-items-center rounded-full bg-black/15 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/cta:translate-x-0.5 motion-reduce:transition-none">
                          <ArrowRight className="size-4" strokeWidth={2} />
                        </span>
                      </>
                    )}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </div>

          <p
            className="auth-rise mt-10 max-w-[26rem] text-xs leading-relaxed text-muted-foreground"
            style={step(5)}
          >
            Sessions last 24 hours and are kept in an HttpOnly cookie.
          </p>
        </section>
      </main>
    </DitherFrame>
  );
}
