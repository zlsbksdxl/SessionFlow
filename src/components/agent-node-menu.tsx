import { Ellipsis, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';

export function AgentNodeMenu({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="nodrag nopan size-6 shrink-0 border-0 text-muted-foreground"
          aria-label={`Agent options: ${label}`}
          title={`Agent options: ${label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Ellipsis className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="bottom"
          sideOffset={5}
          collisionPadding={8}
          aria-label={`Agent actions: ${label}`}
          className="app-region-no-drag nodrag nopan z-50 min-w-44 rounded-xl border border-border/70 bg-popover p-1 font-sans text-popover-foreground shadow-lg outline-none"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu.Item
            disabled={!onRemove}
            className="flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2 text-[13px] text-destructive outline-none transition-colors data-[highlighted]:bg-destructive/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
            onSelect={onRemove}
          >
            <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
            Remove from graph
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
