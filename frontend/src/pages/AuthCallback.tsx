import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

export default function AuthCallback() {
  const navigate = useNavigate();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

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
