"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error("Invalid token");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-[12vh] max-w-[380px]">
      <Card emphasis="primary">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">
          UsageFoundry
        </h1>
        <p className="mb-4 text-ink-muted">
          Enter the access token from{" "}
          <span className="mono">UF_AUTH_TOKEN</span>.
        </p>
        <form onSubmit={submit}>
          <Field label="Access token" htmlFor="token">
            <Input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              required
            />
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button type="submit" disabled={busy || !token}>
            {busy ? "Checking…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
