import React, { useState } from "react";
import { signIn, authClient } from "../lib/auth-client";

interface Props {
  navigate: (to: string) => void;
}

export default function Login({ navigate }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn.email({
      email,
      password,
    });

    if (result.error) {
      setError(result.error.message || "Failed to sign in");
      setLoading(false);
    } else {
      navigate("/dashboard");
    }
  };

  const handleGoogleSignIn = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Sign In</h1>
        <form onSubmit={handleSubmit} style={styles.form}>
          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.field}>
            <label style={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              required
            />
          </div>
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
        <div style={styles.divider}>
          <span style={styles.dividerText}>or</span>
        </div>
        <button onClick={handleGoogleSignIn} style={styles.googleButton}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </button>
        <p style={styles.footer}>
          Don't have an account?{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/signup"); }} style={styles.link}>
            Sign up
          </a>
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    padding: "20px",
  },
  card: {
    backgroundColor: "#fff",
    padding: "40px",
    borderRadius: "12px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
    width: "100%",
    maxWidth: "400px",
  },
  title: {
    fontSize: "28px",
    fontWeight: "bold",
    marginBottom: "24px",
    textAlign: "center",
    color: "#1a1a1a",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  label: {
    fontSize: "14px",
    fontWeight: "500",
    color: "#333",
  },
  input: {
    padding: "12px",
    fontSize: "16px",
    border: "1px solid #ddd",
    borderRadius: "8px",
    outline: "none",
  },
  button: {
    padding: "14px",
    fontSize: "16px",
    fontWeight: "600",
    color: "#fff",
    backgroundColor: "#2563eb",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    marginTop: "8px",
  },
  error: {
    padding: "12px",
    backgroundColor: "#fee2e2",
    color: "#dc2626",
    borderRadius: "8px",
    fontSize: "14px",
  },
  footer: {
    marginTop: "24px",
    textAlign: "center",
    fontSize: "14px",
    color: "#666",
  },
  link: {
    color: "#2563eb",
    textDecoration: "none",
    fontWeight: "500",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    margin: "24px 0",
  },
  dividerText: {
    flex: 1,
    textAlign: "center",
    fontSize: "14px",
    color: "#999",
    position: "relative",
  },
  googleButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    width: "100%",
    padding: "14px",
    fontSize: "16px",
    fontWeight: "500",
    color: "#333",
    backgroundColor: "#fff",
    border: "1px solid #ddd",
    borderRadius: "8px",
    cursor: "pointer",
  },
};
