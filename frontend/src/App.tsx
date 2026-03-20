import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import NewProject from "./pages/NewProject";
import Chat from "./pages/Chat";
import PlanApproval from "./pages/PlanApproval";
import Execution from "./pages/Execution";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <nav className="border-b border-gray-800 px-6 py-3 flex gap-6">
        <Link className="font-semibold text-blue-400" to="/">
          Multi-Agent Harness
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/projects/new">
          + New Project
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/settings">
          Settings
        </Link>
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:id/chat" element={<Chat />} />
          <Route path="/projects/:id/plan" element={<PlanApproval />} />
          <Route path="/projects/:id/execute" element={<Execution />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
