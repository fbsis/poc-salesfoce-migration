import type { ReactNode } from 'react';
import { cn } from './format';

export interface Column {
  label: string;
  align?: 'left' | 'right';
}

/**
 * Consistent, accessible table chrome: `<caption>` for screen readers, real
 * `<th scope="col">`, horizontal scroll instead of layout breakage on narrow
 * viewports, and an optional footer for "showing X of Y".
 */
export function DataTable({
  caption,
  columns,
  children,
  footer,
  className,
  plain = false,
}: {
  caption: string;
  columns: Column[];
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Drop the card chrome when the table sits inside its own panel. */
  plain?: boolean;
}) {
  return (
    <div
      className={cn(
        plain ? '' : 'overflow-hidden rounded-xl border border-slate-200 bg-white',
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-4 py-3 font-semibold',
                    column.align === 'right' && 'text-right',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">{children}</tbody>
        </table>
      </div>
      {footer ? (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="align-top transition-colors hover:bg-slate-50">{children}</tr>;
}

export function TableCell({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 text-slate-700',
        align === 'right' && 'text-right tabular-nums',
        className,
      )}
    >
      {children}
    </td>
  );
}
