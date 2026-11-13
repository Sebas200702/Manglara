import { useEffect, useRef, useState } from "react";
import { Clock, KeyRound, LogIn } from "lucide-react";
import { Logo } from "../../components/brand/logo";

export function LoginView({
  onLogin,
  notice,
}: {
  onLogin: (password: string) => Promise<void>;
  /** Context message such as an expired session. */
  notice?: string | null;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  // after a failed attempt, put the cursor back in the password field
  useEffect(() => {
    if (error && !busy) {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }
  }, [error, busy]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "No se pudo iniciar sesión. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[#f8faf6] font-montserrat flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Logo />
          <p className="mt-2 text-xs font-bold uppercase tracking-widest text-neutral-400">
            Panel de conocimiento
          </p>
        </div>
        <form
          onSubmit={submit}
          className="bg-white rounded-2xl border border-neutral-200/80 shadow-sm p-6 flex flex-col gap-4"
        >
          {notice && !error && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2"
            >
              <Clock className="h-4 w-4 shrink-0" />
              {notice}
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-700 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-neutral-400" />
              Clave del gestor
            </span>
            <input
              ref={passwordRef}
              type="password"
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 focus:bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-300/60 transition"
            />
          </label>
          {error && (
            <p
              id="login-error"
              role="alert"
              className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm px-4 py-2.5 transition"
          >
            <LogIn className="h-4 w-4" />
            {busy ? "Verificando…" : "Entrar"}
          </button>
          <p className="text-xs text-neutral-500 leading-relaxed">
            La clave la define quien administra el sistema. Si la olvidaste, se
            puede reciclar con <code className="font-mono">scripts/hash_password.py</code>.
          </p>
        </form>
      </div>
    </div>
  );
}
