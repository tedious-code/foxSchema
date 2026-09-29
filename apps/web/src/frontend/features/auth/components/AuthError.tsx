import React from 'react';
import { AlertCircle } from 'lucide-react';

/** The error box every sign-in page shows under its fields. */
export const AuthError: React.FC<{ message: string | null | undefined }> = ({ message }) =>
  message ? (
    <div
      role="alert"
      className="flex items-start gap-2 text-xs text-rose-300 bg-rose-950/30 border border-rose-500/20 rounded-md px-3 py-2"
    >
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  ) : null;
