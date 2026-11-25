'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import { buttonPrimary, buttonSecondary } from './page-header';
import { cn } from './format';

/**
 * Submit button with a pending state driven by `useFormStatus`, so every form
 * gets a disabled button + label swap without local state.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Saving…',
  variant = 'primary',
  className,
  name,
  value,
  title,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary';
  className?: string;
  name?: string;
  value?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      disabled={pending}
      aria-disabled={pending || undefined}
      className={cn(variant === 'primary' ? buttonPrimary : buttonSecondary, className)}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
