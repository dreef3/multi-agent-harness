import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { upsertUser } from "../store/users.js";

// ── AuthUser ──────────────────────────────────────────────────────────────────

export type Role = "admin" | "operator" | "reviewer" | "viewer";

export interface AuthUser {
  sub: string;
  email: string;
  displayName: string;
  roles: Role[];
}

// ── Role mapping ──────────────────────────────────────────────────────────────

function mapRoles(rawRoles: unknown[]): Role[] {
  const out: Role[] = [];
  const s = (v: unknown): string => String(v);
  if (rawRoles.some(r => s(r) === config.oidcRoleMapAdmin))    out.push("admin");
  if (rawRoles.some(r => s(r) === config.oidcRoleMapOperator)) out.push("operator");
  if (rawRoles.some(r => s(r) === config.oidcRoleMapReviewer)) out.push("reviewer");
  if (rawRoles.some(r => s(r) === config.oidcRoleMapViewer))   out.push("viewer");
  return out;
}

// ── LOCAL_USER (auth disabled) ────────────────────────────────────────────────

export const LOCAL_USER: AuthUser = {
  sub:         "local",
  email:       "local@localhost",
  displayName: "Local Admin",
  roles:       ["admin"],
};

// ── JWKS cache ────────────────────────────────────────────────────────────────

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _issuerUrl = "";

function getJwks() {
  if (!_jwks || _issuerUrl !== config.oidcIssuerUrl) {
    _issuerUrl = config.oidcIssuerUrl;
    const jwksUrl = new URL(
      `${config.oidcIssuerUrl.replace(/\/$/, "")}/.well-known/jwks.json`
    );
    _jwks = createRemoteJWKSet(jwksUrl, { cacheMaxAge: 10 * 60 * 1000 });
  }
  return _jwks;
}

// ── verifyJwt middleware ──────────────────────────────────────────────────────

export function verifyJwt(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // When auth is disabled inject a synthetic admin and pass through
    if (!config.authEnabled) {
      req.user = LOCAL_USER;
      return next();
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = header.slice(7);
    try {
      const { payload } = await jwtVerify(token, getJwks(), {
        issuer:   config.oidcIssuerUrl,
        audience: config.oidcAudience,
      });

      const rawRoles = Array.isArray(payload[config.oidcRoleClaim])
        ? (payload[config.oidcRoleClaim] as unknown[])
        : [];
      const roles = mapRoles(rawRoles);

      const user: AuthUser = {
        sub:         String(payload.sub ?? ""),
        email:       String((payload as Record<string, unknown>)["email"] ?? ""),
        displayName: String(
          (payload as Record<string, unknown>)["name"] ??
          (payload as Record<string, unknown>)["email"] ??
          payload.sub ??
          ""
        ),
        roles,
      };

      req.user = user;

      await upsertUser({
        id:          user.sub,
        email:       user.email,
        displayName: user.displayName,
        roles:       user.roles,
        lastSeen:    new Date().toISOString(),
        createdAt:   new Date().toISOString(),
      });

      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

// ── requireRole middleware ────────────────────────────────────────────────────

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user || !roles.some(r => user.roles.includes(r))) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

// ── verifyWsToken (used by WebSocket upgrade handler) ────────────────────────

export async function verifyWsToken(token: string): Promise<AuthUser | null> {
  if (!config.authEnabled) {
    return LOCAL_USER;
  }
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer:   config.oidcIssuerUrl,
      audience: config.oidcAudience,
    });

    const rawRoles = Array.isArray(payload[config.oidcRoleClaim])
      ? (payload[config.oidcRoleClaim] as unknown[])
      : [];

    return {
      sub:         String(payload.sub ?? ""),
      email:       String((payload as Record<string, unknown>)["email"] ?? ""),
      displayName: String(
        (payload as Record<string, unknown>)["name"] ??
        (payload as Record<string, unknown>)["email"] ??
        payload.sub ??
        ""
      ),
      roles: mapRoles(rawRoles),
    };
  } catch {
    return null;
  }
}
