import { useSyncExternalStore } from "react";
import { getToken } from "./api";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("boomerang:auth", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener("boomerang:auth", onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The operator token, re-rendering on sign-in and sign-out (including a 401 from the API). */
export function useToken(): string | null {
  return useSyncExternalStore(subscribe, getToken, () => null);
}
