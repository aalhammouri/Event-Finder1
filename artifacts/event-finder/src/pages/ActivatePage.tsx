import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import logoSrc from "@assets/Untitled_design_(1)_1780602102372.png";

function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

export default function ActivatePage() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "expired" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const token = getTokenFromUrl();

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
          <h2 className="font-semibold text-lg">Invalid activation link</h2>
          <p className="text-sm text-muted-foreground">This link is missing a token. Please use the link from your email.</p>
          <a href="/request-access" className="text-primary underline text-sm">Request a new link</a>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (password !== confirm) {
      setErrorMsg("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setErrorMsg("Password must be at least 8 characters");
      return;
    }

    setStatus("loading");
    try {
      const res = await fetch("/api/auth/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (res.status === 410) {
        setStatus("expired");
        return;
      }
      if (!res.ok) {
        setErrorMsg(data.error ?? "Activation failed");
        setStatus("error");
        return;
      }

      login(data.token);
      setStatus("success");
      setTimeout(() => setLocation("/"), 1500);
    } catch {
      setErrorMsg("Network error — please try again");
      setStatus("error");
    }
  };

  if (status === "expired") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
          <h2 className="font-semibold text-lg">Link expired</h2>
          <p className="text-sm text-muted-foreground">
            This activation link has expired (links are valid for 7 days).
          </p>
          <a href="/request-access" className="inline-block mt-2 text-primary underline text-sm">
            Request a new activation link
          </a>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-3">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
          <h2 className="font-semibold text-xl">Account activated!</h2>
          <p className="text-sm text-muted-foreground">Redirecting you to the dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4">
          <img src={logoSrc} alt="The Goff Financial Group" className="w-48" />
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Set your password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Choose a password to activate your Web Crawler account.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter password"
            />
          </div>

          {(errorMsg || status === "error") && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {errorMsg ?? "Something went wrong"}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={status === "loading"}>
            {status === "loading" ? "Activating…" : "Activate account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
