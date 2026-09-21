"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import KineticGrid from "@/components/ui/kinetic-grid";

export default function AuthPage() {
  const router = useRouter();
  const { password, setPassword } = useAuth();
  const [value, setValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (password) router.replace("/");
  }, [password, router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) return;
    setPassword(value);
    router.replace("/");
  }

  return (
    <KineticGrid className="auth-page" globalColor="default">
      <main aria-labelledby="auth-page-title">
      <div className="auth-gate-orbit auth-gate-orbit--one" aria-hidden="true" />
      <div className="auth-gate-orbit auth-gate-orbit--two" aria-hidden="true" />
      <Card className="auth-gate-card auth-page-card">
        <CardHeader>
          <div className="auth-gate-brand"><span className="auth-gate-mark">mP</span><span>minhmiceProxy</span></div>
          <div className="auth-gate-status"><span className="status-dot status-dot--ok" />Control plane secure</div>
          <CardTitle id="auth-page-title">Open the control room.</CardTitle>
          <CardDescription>Secure access to live proxy routing.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="auth-gate-form">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-password">Control password</FieldLabel>
                <InputGroup>
                  <InputGroupInput id="auth-password" type={showPassword ? "text" : "password"} autoComplete="current-password" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter your control password" />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? "Hide password" : "Show password"}>
                      {showPassword ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Button type="submit" disabled={!value.trim()}>Open dashboard <ArrowRight data-icon="inline-end" /></Button>
            </FieldGroup>
          </form>
          <p className="auth-gate-footnote">Encrypted session · expires at midnight</p>
        </CardContent>
      </Card>
      </main>
    </KineticGrid>
  );
}
