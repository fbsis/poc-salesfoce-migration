/** Tiny "N records" counter used beside filters so lists state their size. */
export function PageTotals({ total, noun }: { total: number; noun: string }) {
  return (
    <p className="text-xs text-slate-500">
      {total} {noun}
      {total === 1 ? '' : 's'}
    </p>
  );
}
