import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../config.js", () => ({
  config: {
    authEnabled:         false,
    oidcIssuerUrl:       "https://idp.example.com",
    oidcAudience:        "harness",
    oidcRoleClaim:       "roles",
    oidcRoleMapAdmin:    "harness-admins",
    oidcRoleMapOperator: "harness-operators",
    oidcRoleMapReviewer: "harness-reviewers",
    oidcRoleMapViewer:   "harness-viewers",
  },
}));

vi.mock("../auth.js", () => ({
  LOCAL_USER: {
    sub:         "local",
    email:       "local@localhost",
    displayName: "Local Admin",
    roles:       ["admin"],
  },
  verifyWsToken: vi.fn(),
}));

// These imports must come AFTER mocks
import { config } from "../../config.js";
import { verifyWsToken, LOCAL_USER } from "../auth.js";
import { resolveWsUser } from "../websocket.js";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveWsUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as Record<string, unknown>).authEnabled = false;
  });

  it("returns LOCAL_USER when auth is disabled, regardless of token", async () => {
    (config as Record<string, unknown>).authEnabled = false;
    const user = await resolveWsUser(null, false);
    expect(user).toEqual(LOCAL_USER);
    expect(verifyWsToken).not.toHaveBeenCalled();
  });

  it("returns LOCAL_USER when auth is disabled and a token is provided", async () => {
    const user = await resolveWsUser("some-token", false);
    expect(user).toEqual(LOCAL_USER);
    expect(verifyWsToken).not.toHaveBeenCalled();
  });

  it("throws when auth is enabled and no token is provided", async () => {
    await expect(resolveWsUser(null, true)).rejects.toThrow("No token provided");
    expect(verifyWsToken).not.toHaveBeenCalled();
  });

  it("throws when auth is enabled and verifyWsToken returns null (invalid token)", async () => {
    vi.mocked(verifyWsToken).mockResolvedValueOnce(null);
    await expect(resolveWsUser("bad-token", true)).rejects.toThrow("Invalid or expired token");
    expect(verifyWsToken).toHaveBeenCalledWith("bad-token");
  });

  it("returns the user when auth is enabled and token is valid", async () => {
    const mockUser = {
      sub:         "user-123",
      email:       "user@example.com",
      displayName: "Test User",
      roles:       ["admin"] as ["admin"],
    };
    vi.mocked(verifyWsToken).mockResolvedValueOnce(mockUser);
    const user = await resolveWsUser("valid-token", true);
    expect(user).toEqual(mockUser);
    expect(verifyWsToken).toHaveBeenCalledWith("valid-token");
  });
});
