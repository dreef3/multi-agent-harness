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

export const LOCAL_USER: AuthUser = {
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

export function getUserManager(): UserManager {
  if (!_userManager) {
    _userManager = new UserManager({
      authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "",
      client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "",
      redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${window.location.origin}/auth/callback`,
      scope: import.meta.env.VITE_OIDC_SCOPE ?? "openid profile email",
      response_type: "code",
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      automaticSilentRenew: true,
      response_mode: "query",
    });
  }
  return _userManager;
}

// ---- Role extraction -------------------------------------------------------

function extractRoles(oidcUser: OidcUser): string[] {
  const claimPath = import.meta.env.VITE_OIDC_ROLE_CLAIM ?? "roles";
  const profile = oidcUser.profile as Record<string, unknown>;
  const claim = claimPath.split(".").reduce((obj: unknown, key: string): unknown =>
    obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined,
    profile as unknown
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

    manager.getUser().then(oidcUser => {
      if (oidcUser && !oidcUser.expired) {
        setUser(oidcUserToAuthUser(oidcUser));
      }
      setIsLoading(false);
    });

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
    sessionStorage.setItem("auth_redirect", window.location.pathname + window.location.search);
    await getUserManager().signinRedirect();
  }, [authEnabled]);

  const logout = useCallback(async () => {
    if (!authEnabled) return;
    await getUserManager().signoutRedirect();
  }, [authEnabled]);

  const getAccessToken = useCallback((): string | null => {
    if (!authEnabled) return null;
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
