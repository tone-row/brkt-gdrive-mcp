import React from "react";

interface Props {
  navigate: (to: string) => void;
}

export default function Landing({ navigate }: Props) {
  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <h1 style={styles.title}>Google Drive Search</h1>
        <p style={styles.subtitle}>
          Semantic search over your Google Docs, powered by AI
        </p>
        <p style={styles.description}>
          Connect your Google Drive and search through all your documents
          using natural language. Find what you need, fast.
        </p>
        <div style={styles.buttons}>
          <button style={styles.primaryButton} onClick={() => navigate("/signup")}>
            Get Started
          </button>
          <button style={styles.secondaryButton} onClick={() => navigate("/login")}>
            Sign In
          </button>
        </div>
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
  content: {
    textAlign: "center",
    maxWidth: "600px",
  },
  title: {
    fontSize: "48px",
    fontWeight: "bold",
    marginBottom: "16px",
    color: "#1a1a1a",
  },
  subtitle: {
    fontSize: "24px",
    color: "#4a4a4a",
    marginBottom: "24px",
  },
  description: {
    fontSize: "18px",
    color: "#666",
    marginBottom: "32px",
    lineHeight: "1.6",
  },
  buttons: {
    display: "flex",
    gap: "16px",
    justifyContent: "center",
  },
  primaryButton: {
    padding: "14px 32px",
    fontSize: "18px",
    fontWeight: "600",
    color: "#fff",
    backgroundColor: "#2563eb",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "14px 32px",
    fontSize: "18px",
    fontWeight: "600",
    color: "#2563eb",
    backgroundColor: "#fff",
    border: "2px solid #2563eb",
    borderRadius: "8px",
    cursor: "pointer",
  },
};
