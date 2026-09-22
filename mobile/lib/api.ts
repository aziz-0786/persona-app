import * as SecureStore from "expo-secure-store";
import { SESSION_TOKEN_KEY } from "./auth";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);

  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}
