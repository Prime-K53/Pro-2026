/**
 * Typed toast notifications.
 *
 * Previously every toast used a single success tone, so a failure-adjacent
 * message ("Could not post invoice") was rendered with a green check.
 */
export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastNotice {
  text: string;
  tone: ToastTone;
}
