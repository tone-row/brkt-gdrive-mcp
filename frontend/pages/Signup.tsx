import React, { useState } from "react";
import { signUp } from "../lib/auth-client";

interface Props {
  navigate: (to: string) => void;
}

export default function Signup({ navigate }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signUp.email({
      name,
      email,
      password,
    });

    if (result.error) {
      setError(result.error.message || "Failed to sign up");
      setLoading(false);
    } else {
      navigate("/dashboard");
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create Account</h1>
        <form onSubmit={handleSubmit} style={styles.form}>
          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.field}>
            <label style={styles.label}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={styles.input}
              required
            />
          </div>
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
              minLength={8}
            />
          </div>
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "Creating account..." : "Sign Up"}
          </button>
        </form>
        <p style={styles.footer}>
          Already have an account?{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/login"); }} style={styles.link}>
            Sign in
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
};
