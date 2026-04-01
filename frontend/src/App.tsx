import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import NewProject from "./pages/NewProject";
import Chat from "./pages/Chat";
import PlanApproval from "./pages/PlanApproval";
import Execution from "./pages/Execution";
import Settings from "./pages/Settings";
import PrOverview from "./pages/PrOverview";
import AuthCallback from "./pages/AuthCallback";
import { useAuth } from "./auth/index.js";

export default function App() {
  const { user, isAuthenticated, login, logout } = useAuth();
  const authEnabled = import.meta.env.VITE_AUTH_ENABLED === "true";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <nav className="border-b border-gray-800 px-6 py-3 flex gap-6 items-center">
        <Link className="font-semibold text-blue-400" to="/">
          Multi-Agent Harness
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/projects/new">
          + New Project
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/settings">
          Settings
        </Link>
        {authEnabled && (
          isAuthenticated
            ? (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-gray-400 text-sm">{user?.name}</span>
                <button
                  className="text-gray-400 hover:text-white text-sm"
                  onClick={logout}
                >
                  Sign out
                </button>
              </div>
            )
            : (
              <button
                className="ml-auto text-gray-400 hover:text-white text-sm"
                onClick={login}
              >
                Sign in
              </button>
            )
        )}
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:id/chat" element={<Chat />} />
          <Route path="/projects/:id/plan" element={<PlanApproval />} />
          <Route path="/projects/:id/execute" element={<Execution />} />
          <Route path="/projects/:id/prs" element={<PrOverview />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </main>
    </div>
  );
}
