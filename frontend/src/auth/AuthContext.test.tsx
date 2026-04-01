import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext.js";

vi.mock("oidc-client-ts", () => ({
  UserManager: vi.fn().mockImplementation(() => ({
    getUser: vi.fn().mockResolvedValue(null),
    signinRedirect: vi.fn(),
    signoutRedirect: vi.fn(),
    events: {
      addUserLoaded: vi.fn(),
      addUserUnloaded: vi.fn(),
      removeUserLoaded: vi.fn(),
      removeUserUnloaded: vi.fn(),
    },
  })),
  WebStorageStateStore: vi.fn(),
}));

function TestComponent() {
  const { user, isAuthenticated } = useAuth();
  return (
    <div>
      <span data-testid="user">{user?.name ?? "none"}</span>
      <span data-testid="auth">{isAuthenticated ? "yes" : "no"}</span>
    </div>
  );
}

describe("AuthProvider (AUTH_ENABLED=false)", () => {
  beforeEach(() => {
    (import.meta.env as Record<string, string>).VITE_AUTH_ENABLED = "false";
  });

  it("provides LOCAL_USER without network calls", async () => {
    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("Local User");
      expect(screen.getByTestId("auth").textContent).toBe("yes");
    });
  });
});
