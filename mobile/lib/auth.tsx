import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import type { Session, User } from "./types";

WebBrowser.maybeCompleteAuthSession();

export const SESSION_TOKEN_KEY = "session_token";
// Not in the original spec (which only names "session_token") — added so
// `session.user` can be restored on relaunch without a dedicated "whoami"
// endpoint. The JWT remains the sole source of truth for auth; this is only
// a display-data cache, cleared alongside the token on sign-out.
const SESSION_USER_KEY = "session_user";

type AuthContextValue = {
  session: Session | null;
  isLoading: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // GoogleAuthRequestConfig is deprecated in this Expo SDK in favor of
  // @react-native-google-signin/google-signin, but still functional and is
  // what this was asked to use. useIdTokenAuthRequest (not the generic
  // useAuthRequest) is required here — it's the variant that actually
  // returns a verifiable ID token, at response.params.id_token, which is
  // what /api/auth/mobile-token expects to hand to Google's tokeninfo
  // endpoint. EXPO_PUBLIC_GOOGLE_CLIENT_ID is wired into all three
  // platform slots as a placeholder — Google OAuth client IDs are normally
  // per-platform (separate iOS/Android/Web IDs from Google Cloud Console),
  // so this will likely need to split into three env vars once real client
  // IDs exist.
  const [, response, promptAsync] = Google.useIdTokenAuthRequest({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  });

  // Restore a persisted session on launch.
  useEffect(() => {
    (async () => {
      try {
        const [token, userJson] = await Promise.all([
          SecureStore.getItemAsync(SESSION_TOKEN_KEY),
          SecureStore.getItemAsync(SESSION_USER_KEY),
        ]);
        if (token && userJson) setSession({ token, user: JSON.parse(userJson) as User });
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Fires once Google's auth prompt resolves — exchanges the ID token for
  // this app's own session JWT via the web project's token-exchange route.
  useEffect(() => {
    if (response?.type !== "success") return;
    const googleToken = response.params.id_token;
    if (!googleToken) return;

    (async () => {
      try {
        const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/auth/mobile-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ googleToken }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Sign-in failed");

        await SecureStore.setItemAsync(SESSION_TOKEN_KEY, data.token);
        await SecureStore.setItemAsync(SESSION_USER_KEY, JSON.stringify(data.user));
        setSession({ token: data.token, user: data.user });
      } catch (err) {
        // Never log the token itself — only that the exchange failed.
        console.error("[AUTH] mobile-token exchange failed:", err instanceof Error ? err.message : err);
      }
    })();
  }, [response]);

  async function signOut() {
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
    await SecureStore.deleteItemAsync(SESSION_USER_KEY);
    setSession(null);
  }

  function signIn() {
    promptAsync();
  }

  return (
    <AuthContext.Provider value={{ session, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useGoogleAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useGoogleAuth must be used within a SessionProvider");
  return ctx;
}
