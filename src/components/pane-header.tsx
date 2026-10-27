import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function PaneHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      data-slot="pane-header"
      className={cn('orrery-pane-header app-region-drag flex h-11 min-h-11 min-w-0 shrink-0 select-none items-center border-b border-border bg-background px-3.5 text-foreground', className)}
      {...props}
    />
  );
}
