"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";

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
      // A server with no token configured answers 409 and says so. Reported
      // rather than redirected past: the banner above this card already states
      // it, and a "signed in" that checked nothing is the lie this screen
      // would otherwise be telling.
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Authentication is disabled");
      }
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
        {/* The first thing anyone sees of this app. The mark and the name are
            the whole of it — there is one field below and nothing to choose. */}
        <div className="mb-4 flex items-center gap-2.5">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 shrink-0"
            aria-hidden
            focusable="false"
          >
            <rect width="24" height="24" rx="6" className="fill-accent" />
            <rect x="6" y="13" width="3" height="5" rx="1.5" fill="#fff" />
            <rect x="10.5" y="9.5" width="3" height="8.5" rx="1.5" fill="#fff" />
            <rect x="15" y="6" width="3" height="12" rx="1.5" fill="#fff" />
          </svg>
          <h1 className="text-xl font-semibold tracking-tight">UsageFoundry</h1>
        </div>

        <form onSubmit={submit}>
          <Field
            label="Access token"
            htmlFor="token"
            hint={
              <>
                The value of <span className="mono">UF_AUTH_TOKEN</span> in your{" "}
                <span className="mono">.env</span>
              </>
            }
            // On the field rather than in a Notice below the form: the message
            // is about this one box, so it reaches the box as
            // aria-describedby, turns its border red, and is announced when it
            // arrives. A banner under the button was none of those things.
            error={error}
          >
            <Input
              id="token"
              type="password"
              name="token"
              autoComplete="current-password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                // The message described the previous attempt. Keeping it while
                // the value changes says the new value is wrong too.
                if (error) setError(null);
              }}
              autoFocus
              required
            />
          </Field>
          <Button type="submit" busy={busy} disabled={!token} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
