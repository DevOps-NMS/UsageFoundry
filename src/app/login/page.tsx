"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="card center-card">
      <h1>UsageFoundry</h1>
      <p className="lede" style={{ marginBottom: 16 }}>
        Enter the access token from <span className="mono">UF_AUTH_TOKEN</span>.
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            required
          />
        </div>
        {error && (
          <div className="notice" data-tone="danger">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !token}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
