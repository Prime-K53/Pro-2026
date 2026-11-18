import React, { useEffect, useRef } from 'react';

interface DropdownPanelProps {
  id: string;
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  labelledBy: string;
  align?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}

/**
 * Shared accessible dropdown surface for every header menu.
 *
 * - Opens with focus on the first item.
 * - Arrow Up/Down, Home and End move focus between menu items.
 * - Escape closes and restores focus to the trigger.
 * - Focus leaving the panel (including Tab) closes it.
 * - Outside clicks and viewport resizes close it.
 */
export const DropdownPanel: React.FC<DropdownPanelProps> = ({
  id,
  open,
  onClose,
  anchorRef,
  labelledBy,
  align = 'start',
  className = '',
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusFrame = window.requestAnimationFrame(() => {
      const firstItem = panel.querySelector<HTMLElement>('[data-menu-item]:not([disabled])');
      (firstItem || panel).focus();
    });

    const listItems = () =>
      Array.from(panel.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])')).filter(
        item => item.getClientRects().length > 0
      );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        anchorRef.current?.focus();
        return;
      }

      const items = listItems();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? items.indexOf(active) : -1;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[index < 0 ? 0 : (index + 1) % items.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };

    const handleResize = () => onCloseRef.current();

    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next) return;
      if (panel.contains(next) || anchorRef.current?.contains(next)) return;
      onCloseRef.current();
    };

    panel.addEventListener('keydown', handleKeyDown);
    panel.addEventListener('focusout', handleFocusOut);
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      panel.removeEventListener('keydown', handleKeyDown);
      panel.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [open, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      aria-orientation="vertical"
      tabIndex={-1}
      className={`hdr-menu-panel ${align === 'end' ? 'hdr-menu-panel-end' : ''} ${className}`.trim()}
    >
      {children}
    </div>
  );
};
