import { useState, type FormEvent } from "react";
import { api, ApiError, setToken } from "../api";

/** The operator types the shared OPERATOR_TOKEN once per browser tab. */
export function SignIn() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setToken(value.trim());
    try {
      await api("/api/summary");
    } catch (err) {
      setToken(null);
      setError(
        err instanceof ApiError && err.status === 401
          ? "That token is not right."
          : `Could not reach the API: ${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="signin">
      <h1>Operator sign-in</h1>
      <p className="muted">Enter the operator token (OPERATOR_TOKEN). It stays in this tab only.</p>
      <form onSubmit={submit}>
        <label htmlFor="token">Operator token</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <button type="submit" disabled={busy || value.trim() === ""}>
          {busy ? "Checking..." : "Sign in"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
