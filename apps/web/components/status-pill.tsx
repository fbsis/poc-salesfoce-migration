import type { LeadStatus, OpportunityStage } from '@poc/core';
import { cn, humanize } from './format';

type Tone = 'slate' | 'blue' | 'amber' | 'emerald' | 'indigo' | 'rose';

const TONE_CLASSES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-600 ring-slate-300',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
};

/** Neutral pill; tone is chosen by the caller. */
export function StatusPill({
  label,
  tone = 'slate',
  className,
}: {
  label: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

const LEAD_STATUS_TONES: Record<LeadStatus, Tone> = {
  new: 'blue',
  contacted: 'amber',
  qualified: 'emerald',
  closed: 'slate',
};

export function leadStatusTone(status: LeadStatus): Tone {
  return LEAD_STATUS_TONES[status] ?? 'slate';
}

/** Lead lifecycle: new → contacted → qualified → closed. */
export function LeadStatusPill({ status, className }: { status: LeadStatus; className?: string }) {
  return <StatusPill label={humanize(status)} tone={leadStatusTone(status)} className={className} />;
}

const STAGE_TONES: Record<OpportunityStage, Tone> = {
  Prospecting: 'slate',
  Qualification: 'blue',
  Proposal: 'indigo',
  Negotiation: 'amber',
  'Closed Won': 'emerald',
  'Closed Lost': 'rose',
};

export function stageTone(stage: OpportunityStage): Tone {
  return STAGE_TONES[stage] ?? 'slate';
}

/** Opportunity stage as a coloured pill; `Closed Won/Lost` read at a glance. */
export function StagePill({
  stage,
  className,
}: {
  stage: OpportunityStage;
  className?: string;
}) {
  return <StatusPill label={stage} tone={stageTone(stage)} className={className} />;
}
