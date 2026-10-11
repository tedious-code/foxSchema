import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning';

export type ToastItem = {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  /** Optional link action (opens in new tab). */
  actionLabel?: string;
  actionHref?: string;
  /** Optional button action (in-app handler). Prefer over href when both set. */
  actionButtonLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss after ms; 0 = sticky until closed. */
  durationMs: number;
};

type ToastState = {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
};

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast-${Date.now()}-${++seq}`;
    const item: ToastItem = {
      id,
      durationMs: toast.durationMs ?? 6_000,
      title: toast.title,
      body: toast.body,
      tone: toast.tone,
      actionLabel: toast.actionLabel,
      actionHref: toast.actionHref,
      actionButtonLabel: toast.actionButtonLabel,
      onAction: toast.onAction,
    };
    set((s) => ({ toasts: [...s.toasts.slice(-4), item] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for non-React call sites. */
export function toast(
  input: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }
): string {
  return useToastStore.getState().push(input);
}
