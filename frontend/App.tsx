import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useSession } from "./lib/auth-client";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";

function Router() {
  const [path, setPath] = useState(window.location.pathname);
  const { data: session, isPending } = useSession();

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  };

  if (isPending) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        Loading...
      </div>
    );
  }

  // Redirect to dashboard if logged in and on auth pages
  if (session && (path === "/login" || path === "/signup")) {
    window.history.replaceState({}, "", "/dashboard");
    return <Dashboard navigate={navigate} />;
  }

  // Redirect to login if not logged in and on protected pages
  if (!session && path === "/dashboard") {
    window.history.replaceState({}, "", "/login");
    return <Login navigate={navigate} />;
  }

  switch (path) {
    case "/login":
      return <Login navigate={navigate} />;
    case "/signup":
      return <Signup navigate={navigate} />;
    case "/dashboard":
      return <Dashboard navigate={navigate} />;
    default:
      return <Landing navigate={navigate} />;
  }
}

function App() {
  return <Router />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
