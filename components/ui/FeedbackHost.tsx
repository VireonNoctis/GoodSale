// components/ui/FeedbackHost.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Toast from './Toast';
import Dialog from './Dialog';
import Button from './Button';
import {
  subscribeToasts,
  dismissToast,
  subscribeConfirm,
  resolveConfirm,
  type ToastItem,
  type ConfirmState,
} from '../../lib/feedback';

/**
 * Mounts once at the app root. Renders every global toast and the themed
 * confirmation dialog so no component needs to own pop-up state.
 */
export default function FeedbackHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => subscribeToasts(setToasts), []);
  useEffect(() => subscribeConfirm(setConfirm), []);

  return (
    <>
      <div className="pointer-events-none fixed bottom-24 right-4 z-[120] flex w-full max-w-xs flex-col items-end gap-2 md:bottom-6 md:right-6">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismissToast(t.id)}
            className="pointer-events-auto cursor-pointer text-left focus-ring rounded-2xl"
            aria-label="Dismiss notification"
          >
            <Toast kind={t.kind} title={t.title}>
              {t.message}
            </Toast>
          </button>
        ))}
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => resolveConfirm(false)}
        title={confirm?.title}
        description={confirm?.message}
      >
        <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => resolveConfirm(false)}
          >
            {confirm?.cancelText || 'Cancel'}
          </Button>
          <Button
            variant={confirm?.danger ? 'danger' : 'primary'}
            className="w-full sm:w-auto"
            onClick={() => resolveConfirm(true)}
          >
            {confirm?.confirmText || 'Confirm'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
