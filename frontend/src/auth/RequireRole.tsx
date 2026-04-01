import type { ReactNode } from "react";
import { useAuth } from "./AuthContext.js";

interface Props {
  roles: string[];
  fallback?: ReactNode;
  children: ReactNode;
}

export function RequireRole({ roles, fallback = null, children }: Props) {
  const { user } = useAuth();
  const hasRole = roles.some(r => user?.roles.includes(r));
  return hasRole ? <>{children}</> : <>{fallback}</>;
}
