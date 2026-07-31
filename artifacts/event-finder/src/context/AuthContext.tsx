import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  exp?: number;
}

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  user: null,
  login: () => {},
  logout: () => {},
});

const TOKEN_KEY = "auth_token";

function decodeJwt(token: string): AuthUser | null {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as AuthUser;
  } catch {
    return null;
  }
}

function isExpired(user: AuthUser): boolean {
  if (!user.exp) return false;
  return Date.now() / 1000 > user.exp;
}

function loadStoredToken(): { token: string; user: AuthUser } | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) return null;
    const user = decodeJwt(stored);
    if (!user || isExpired(user)) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return { token: stored, user };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const stored = loadStoredToken();

  const [token, setToken] = useState<string | null>(stored?.token ?? null);
  const [user, setUser] = useState<AuthUser | null>(stored?.user ?? null);

  useEffect(() => {
    setAuthTokenGetter(() => token);
  }, [token]);

  const login = (newToken: string) => {
    const payload = decodeJwt(newToken);
    if (!payload) return;
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(payload);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setAuthTokenGetter(null);
  };

  return (
    <AuthContext.Provider value={{ token, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
