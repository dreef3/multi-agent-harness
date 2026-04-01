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
      try {
        const { getUserManager } = await import("./AuthContext.js");
        const renewed = await getUserManager().signinSilent();
        if (renewed?.access_token) {
          const retryHeaders = new Headers(init.headers);
          retryHeaders.set("Authorization", `Bearer ${renewed.access_token}`);
          return fetch(input, { ...init, headers: retryHeaders });
        }
      } catch {
        // Silent renew failed
      }
      await login();
      return response;
    }

    return response;
  }, [getAccessToken, login]);

  return authFetch;
}
