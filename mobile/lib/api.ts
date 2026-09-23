import * as SecureStore from "expo-secure-store";
import { SESSION_TOKEN_KEY } from "./auth";

export const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Carries the HTTP status through so callers can branch on specific codes
// (e.g. 402 "no credits") without re-parsing a plain Error's message.
export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);

  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
      res.status,
      data
    );
  }
  return data as T;
}
