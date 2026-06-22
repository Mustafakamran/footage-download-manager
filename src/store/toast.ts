import type { ReactNode } from "react";
import { create } from "zustand";

export type ToastType = "success" | "error" | "info";
export interface Toast {
  id: number;
  message: ReactNode;
  type: ToastType;
}

let seq = 0;

interface ToastState {
  toasts: Toast[];
  /** Returns the id so callers can dismiss a long-lived toast early. */
  push: (message: ReactNode, type?: ToastType, ttl?: number) => number;
  dismiss: (id: number) => void;
}

const DEFAULT_TTL = 3200;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, type = "success", ttl = DEFAULT_TTL) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    if (ttl > 0) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttl);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
