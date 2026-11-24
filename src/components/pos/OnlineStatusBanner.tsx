import React, { useEffect, useState } from 'react';
import { WifiOff, Wifi } from 'lucide-react';

/**
 * WS-1 P8 / architecture rule 2 — "no offline theatre".
 *
 * POS checkout, inventory adjustments, customer creation and quote creation
 * have no client-side durable queue, so they are **online-only**. This banner
 * tells the cashier plainly when the terminal is offline instead of letting
 * them attempt an action that cannot be queued.
 *
 * External-provider actions (AI, Twilio, QR generation) are always online-only
 * and fail closed server-side; this banner covers the shared "offline" state.
 */
export const OnlineStatusBanner: React.FC<{ scope?: string }> = ({
  scope = 'POS checkout, refunds and inventory actions',
}) => {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (online) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
        <Wifi className="h-4 w-4 shrink-0" />
        <span>
          <strong>Online.</strong> {scope} are available and post to the server immediately.
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>
        <strong>Offline — actions unavailable.</strong> {scope} require a connection because
        there is no local queue. Reconnect to continue; nothing has been lost.
      </span>
    </div>
  );
};