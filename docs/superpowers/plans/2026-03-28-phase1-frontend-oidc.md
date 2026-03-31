# Frontend OIDC Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OIDC Authorization Code + PKCE login/logout flow to the React frontend using `oidc-client-ts`, with an `AuthProvider` context, authenticated fetch wrapper, and role-gated UI components.

**Architecture:** `UserManager` from `oidc-client-ts` handles all PKCE state and token storage (localStorage). `AuthProvider` wraps the app tree and exposes `user`, `login()`, `logout()`, and `getAccessToken()` via React context. A `/auth/callback` route completes the code exchange. `useAuthFetch` wraps `fetch` to attach `Authorization: Bearer` headers and retry once after silent token refresh on 401. When `VITE_AUTH_ENABLED=false` (default), a stub provider injects a synthetic local user so non-auth development flow is unchanged.

**Tech Stack:** `oidc-client-ts`, React context + hooks, Vite environment variables, React Router (existing).

---

## Tasks

- [ ] **Task 1 — Install `oidc-client-ts`**

  ```bash
  cd frontend && bun add oidc-client-ts
  ```

  Verify it appears in `frontend/package.json` dependencies.

- [ ] **Task 2 — Add Vite environment variables**

  Create or extend `frontend/.env.example` (do not write secrets into `.env`):

  ```
  VITE_AUTH_ENABLED=false
  VITE_OIDC_AUTHORITY=https://your-idp.example.com
  VITE_OIDC_CLIENT_ID=harness
  VITE_OIDC_REDIRECT_URI=http://localhost:5173/auth/callback
  VITE_OIDC_SCOPE=openid profile email
  VITE_OIDC_ROLE_CLAIM=roles
  ```

  `VITE_AUTH_ENABLED=false` means no login prompt for local development.

- [ ] **Task 3 — Create `frontend/src/auth/AuthContext.tsx`**

  ```typescript
  import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    useMemo,
  } from "react";
  import { UserManager, WebStorageStateStore } from "oidc-client-ts";
  import type { User as OidcUser } from "oidc-client-ts";

  // ---- Types -----------------------------------------------------------------

  export interface AuthUser {
    sub: string;
    email: string;
    name: string;
    roles: string[];
  }

  interface AuthContextValue {
    user: AuthUser | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: () => Promise<void>;
    logout: () => Promise<void>;
    getAccessToken: () => string | null;
  }

  // ---- Synthetic local user (AUTH_ENABLED=false) ----------------------------

  const LOCAL_USER: AuthUser = {
    sub: "local-user",
    email: "local@localhost",
    name: "Local User",
    roles: ["admin"],
  };

  // ---- Context ---------------------------------------------------------------

  const AuthContext = createContext<AuthContextValue>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    login: async () => {},
    logout: async () => {},
    getAccessToken: () => null,
  });

  // ---- UserManager singleton -------------------------------------------------

  let _userManager: UserManager | null = null;

  function getUserManager(): UserManager {
    if (!_userManager) {
      _userManager = new UserManager({
        authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "",
        client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "",
        redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${window.location.origin}/auth/callback`,
        scope: import.meta.env.VITE_OIDC_SCOPE ?? "openid profile email",
        response_type: "code",
        // tokens stored in localStorage via oidc-client-ts default
        userStore: new WebStorageStateStore({ store: window.localStorage }),
        automaticSilentRenew: true,
        // Store pre-login URL so we can redirect back after callback
        response_mode: "query",
      });
    }
    return _userManager;
  }

  // ---- Role extraction -------------------------------------------------------

  function extractRoles(oidcUser: OidcUser): string[] {
    const claimPath = import.meta.env.VITE_OIDC_ROLE_CLAIM ?? "roles";
    const profile = oidcUser.profile as Record<string, unknown>;
    const claim = claimPath.split(".").reduce<unknown>((obj, key) =>
      obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined,
      profile
    );
    return Array.isArray(claim) ? (claim as string[]) : [];
  }

  function oidcUserToAuthUser(oidcUser: OidcUser): AuthUser {
    return {
      sub: oidcUser.profile.sub,
      email: (oidcUser.profile.email as string) ?? "",
      name: (oidcUser.profile.name as string) ?? oidcUser.profile.sub,
      roles: extractRoles(oidcUser),
    };
  }

  // ---- Provider --------------------------------------------------------------

  export function AuthProvider({ children }: { children: React.ReactNode }) {
    const authEnabled = import.meta.env.VITE_AUTH_ENABLED === "true";

    const [user, setUser] = useState<AuthUser | null>(authEnabled ? null : LOCAL_USER);
    const [isLoading, setIsLoading] = useState(authEnabled);

    useEffect(() => {
      if (!authEnabled) return;

      const manager = getUserManager();

      // Load any existing user from storage on mount
      manager.getUser().then(oidcUser => {
        if (oidcUser && !oidcUser.expired) {
          setUser(oidcUserToAuthUser(oidcUser));
        }
        setIsLoading(false);
      });

      // Listen for token renewal
      const handleUserLoaded = (oidcUser: OidcUser) => {
        setUser(oidcUserToAuthUser(oidcUser));
      };
      const handleUserUnloaded = () => {
        setUser(null);
      };

      manager.events.addUserLoaded(handleUserLoaded);
      manager.events.addUserUnloaded(handleUserUnloaded);

      return () => {
        manager.events.removeUserLoaded(handleUserLoaded);
        manager.events.removeUserUnloaded(handleUserUnloaded);
      };
    }, [authEnabled]);

    const login = useCallback(async () => {
      if (!authEnabled) return;
      // Save current path so callback can redirect back
      sessionStorage.setItem("auth_redirect", window.location.pathname + window.location.search);
      await getUserManager().signinRedirect();
    }, [authEnabled]);

    const logout = useCallback(async () => {
      if (!authEnabled) return;
      await getUserManager().signoutRedirect();
    }, [authEnabled]);

    const getAccessToken = useCallback((): string | null => {
      if (!authEnabled) return null;
      // oidc-client-ts stores access token in memory after loading from storage
      // This is synchronous — call after isLoading=false
      const userManager = getUserManager();
      // Access the internal user directly from storage for synchronous read
      const stored = localStorage.getItem(
        `oidc.user:${import.meta.env.VITE_OIDC_AUTHORITY}:${import.meta.env.VITE_OIDC_CLIENT_ID}`
      );
      if (!stored) return null;
      try {
        return (JSON.parse(stored) as { access_token?: string }).access_token ?? null;
      } catch {
        return null;
      }
    }, [authEnabled]);

    const value = useMemo<AuthContextValue>(() => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      login,
      logout,
      getAccessToken,
    }), [user, isLoading, login, logout, getAccessToken]);

    return (
      <AuthContext.Provider value={value}>
        {children}
      </AuthContext.Provider>
    );
  }

  // ---- Hook ------------------------------------------------------------------

  export function useAuth(): AuthContextValue {
    return useContext(AuthContext);
  }
  ```

- [ ] **Task 4 — Create `frontend/src/auth/useAuthFetch.ts`**

  ```typescript
  import { useCallback } from "react";
  import { useAuth } from "./AuthContext.js";

  type FetchArgs = Parameters<typeof fetch>;

  export function useAuthFetch() {
    const { getAccessToken, login } = useAuth();

    const authFetch = useCallback(async (input: FetchArgs[0], init: FetchArgs[1] = {}): Promise<Response> => {
      const token = getAccessToken();

      const headers = new Headers(init.headers);
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      const response = await fetch(input, { ...init, headers });

      if (response.status === 401 && token) {
        // Token expired between storage read and request.
        // Attempt silent renew via hidden iframe, then retry once with the new token.
        try {
          const { getUserManager } = await import("./AuthContext.js");
          const renewed = await getUserManager().signinSilent();
          if (renewed?.access_token) {
            const retryHeaders = new Headers(init.headers);
            retryHeaders.set("Authorization", `Bearer ${renewed.access_token}`);
            return fetch(input, { ...init, headers: retryHeaders });
          }
        } catch {
          // Silent renew failed (e.g. session ended, third-party cookies blocked)
        }
        // Redirect to login as final fallback
        await login();
        return response; // unreachable after redirect, satisfies type
      }

      return response;
    }, [getAccessToken, login]);

    return authFetch;
  }
  ```

  > Note: `getUserManager()` is the module-level singleton from `AuthContext.ts`. If the project uses a dedicated API client module (e.g. `frontend/src/api.ts`), attach the auth header there instead of using this hook directly, to avoid duplication. The `getAccessToken()` synchronous read does not check `expires_at` — an expired token will get a 401 and trigger the silent-renew path above, which is the correct recovery path.

- [ ] **Task 5 — Create `frontend/src/pages/AuthCallback.tsx`**

  ```typescript
  import { useEffect, useRef } from "react";
  import { useNavigate } from "react-router-dom";
  import { UserManager, WebStorageStateStore } from "oidc-client-ts";

  export default function AuthCallback() {
    const navigate = useNavigate();
    const handledRef = useRef(false);

    useEffect(() => {
      if (handledRef.current) return;
      handledRef.current = true;

      // Re-use the same UserManager singleton by importing the getter
      // (or instantiate with matching config — must match AuthContext exactly)
      const manager = new UserManager({
        authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "",
        client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "",
        redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${window.location.origin}/auth/callback`,
        userStore: new WebStorageStateStore({ store: window.localStorage }),
      });

      manager
        .signinRedirectCallback()
        .then(() => {
          const redirectTo = sessionStorage.getItem("auth_redirect") ?? "/";
          sessionStorage.removeItem("auth_redirect");
          navigate(redirectTo, { replace: true });
        })
        .catch(err => {
          console.error("Auth callback error:", err);
          navigate("/", { replace: true });
        });
    }, [navigate]);

    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <p>Completing sign-in...</p>
      </div>
    );
  }
  ```

- [ ] **Task 6 — Create `frontend/src/auth/RequireRole.tsx`**

  ```typescript
  import type { ReactNode } from "react";
  import { useAuth } from "./AuthContext.js";

  interface Props {
    roles: string[];
    fallback?: ReactNode;
    children: ReactNode;
  }

  /**
   * Renders children only when the authenticated user holds at least one
   * of the listed roles. Renders fallback (default: null) otherwise.
   *
   * Usage:
   *   <RequireRole roles={["admin", "operator"]}>
   *     <DeleteButton />
   *   </RequireRole>
   */
  export function RequireRole({ roles, fallback = null, children }: Props) {
    const { user } = useAuth();
    const hasRole = roles.some(r => user?.roles.includes(r));
    return hasRole ? <>{children}</> : <>{fallback}</>;
  }
  ```

- [ ] **Task 7 — Create `frontend/src/auth/index.ts` barrel**

  ```typescript
  export { AuthProvider, useAuth } from "./AuthContext.js";
  export { useAuthFetch } from "./useAuthFetch.js";
  export { RequireRole } from "./RequireRole.js";
  export type { AuthUser } from "./AuthContext.js";
  ```

- [ ] **Task 8 — Wire `AuthProvider` into `frontend/src/main.tsx` or `App.tsx`**

  Open the root component file. Import and wrap the app tree:

  ```typescript
  import { AuthProvider } from "./auth/index.js";

  // Wrap existing tree:
  root.render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
  ```

  If using React Router's `BrowserRouter`, `AuthProvider` should be inside it so `useNavigate` works in `AuthCallback`.

- [ ] **Task 9 — Add `/auth/callback` route in the React Router config**

  Find the file that defines routes (likely `App.tsx` or a `routes.ts`). Add:

  ```typescript
  import AuthCallback from "./pages/AuthCallback.js";

  // Inside <Routes>:
  <Route path="/auth/callback" element={<AuthCallback />} />
  ```

- [ ] **Task 10 — Add login button to header/nav (when `AUTH_ENABLED=true`)**

  In the main navigation component, add conditional login/logout controls:

  ```typescript
  import { useAuth } from "../auth/index.js";

  const { user, isAuthenticated, login, logout } = useAuth();
  const authEnabled = import.meta.env.VITE_AUTH_ENABLED === "true";

  // In JSX:
  {authEnabled && (
    isAuthenticated
      ? (
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span>{user?.name}</span>
          <button onClick={logout}>Sign out</button>
        </div>
      )
      : <button onClick={login}>Sign in</button>
  )}
  ```

- [ ] **Task 11 — TypeScript compile check**

  ```bash
  cd frontend && bun run tsc --noEmit
  ```

  Fix any errors before proceeding.

- [ ] **Task 12 — Write unit tests `frontend/src/auth/AuthContext.test.tsx`**

  ```typescript
  import { render, screen, waitFor } from "@testing-library/react";
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { AuthProvider, useAuth, LOCAL_USER } from "./AuthContext.js";

  // Stub oidc-client-ts
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
      import.meta.env.VITE_AUTH_ENABLED = "false";
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
  ```

  Run:
  ```bash
  cd frontend && bun test src/auth/AuthContext.test.tsx
  ```

---

## Verification Checklist

- [ ] `oidc-client-ts` in `frontend/package.json` dependencies
- [ ] `VITE_AUTH_ENABLED=false` (default) → app renders without login prompt, `LOCAL_USER` injected
- [ ] `VITE_AUTH_ENABLED=true` → app calls `manager.signinRedirect()` when no token in storage
- [ ] `/auth/callback` route exchanges code, redirects to pre-login URL
- [ ] `useAuthFetch` attaches `Authorization: Bearer` header when token present
- [ ] `<RequireRole roles={["admin"]}>` hides children from users without that role
- [ ] TypeScript strict-mode compile passes
- [ ] Unit test for `AuthProvider` (auth disabled path) passes
