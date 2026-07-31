import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2 } from "lucide-react";
import logoSrc from "@assets/Untitled_design_(1)_1780602102372.png";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "Something went wrong");
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setErrorMsg("Network error — please try again");
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4">
          <img src={logoSrc} alt="The Goff Financial Group" className="w-48" />
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Forgot password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Enter your email and we'll send you a link to reset your password.
            </p>
          </div>
        </div>

        {status === "success" ? (
          <div className="text-center space-y-3 bg-green-50 border border-green-200 rounded-lg p-6">
            <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
            <h2 className="font-semibold text-green-800">Check your email</h2>
            <p className="text-sm text-green-700">
              If an account exists for <strong>{email}</strong>, a password reset link is on its way.
              It expires in 1 hour.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@gofffinancial.com"
              />
            </div>

            {status === "error" && errorMsg && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{errorMsg}</p>
            )}

            <Button type="submit" className="w-full" disabled={status === "loading"}>
              {status === "loading" ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <a href="/login" className="text-primary underline underline-offset-4 hover:text-primary/80">
            Back to sign in
          </a>
        </p>
      </div>
    </div>
  );
}
