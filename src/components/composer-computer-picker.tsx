import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe, Laptop, Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';

import type { ChatComputerOption } from '@/lib/chat-computers';

function computerHint(computer: ChatComputerOption) {
  return computer.connection.kind === 'ssh' ? `${computer.label}\n${computer.cwd}\n${computer.connection.runtimePath}` : `${computer.label}\n${computer.cwd}`;
}

export function ComposerComputerPicker({
  computers,
  value,
  disabled,
  onChange,
  onNewRemoteProject,
}: {
  computers: ChatComputerOption[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  onNewRemoteProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const newRemoteProjectPending = useRef(false);
  const selected = computers.find((computer) => computer.id === value);
  const SelectedIcon = selected?.connection.kind === 'ssh' ? Globe : Laptop;

  useEffect(() => {
    if (disabled) {
      newRemoteProjectPending.current = false;
      setOpen(false);
    }
  }, [disabled]);

  return (
    <DropdownMenu.Root open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}>
      <DropdownMenu.Trigger
        disabled={disabled}
        aria-label="Computer"
        title={selected ? computerHint(selected) : 'Choose computer'}
        className="group relative flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md bg-muted/55 px-2 font-sans outline-none transition hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-55 data-[state=open]:bg-foreground/[0.04]"
      >
        <SelectedIcon className="size-3.5 shrink-0 text-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-left text-xs text-foreground/85">{selected?.label ?? 'Choose computer'}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-180 group-data-[state=open]:opacity-100" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (!newRemoteProjectPending.current) return;
            event.preventDefault();
            newRemoteProjectPending.current = false;
            queueMicrotask(onNewRemoteProject);
          }}
          className="app-region-no-drag z-60 w-64 min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-24px)] overflow-hidden rounded-lg border border-border/60 bg-popover p-1 font-sans text-popover-foreground shadow-lg outline-none"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== value) onChange(next);
            }}
            className="max-h-64 space-y-0.5 overflow-y-auto"
          >
            {computers.map((computer) => {
              const Icon = computer.connection.kind === 'ssh' ? Globe : Laptop;
              return (
                <DropdownMenu.RadioItem
                  key={computer.id}
                  value={computer.id}
                  textValue={computer.label}
                  title={computerHint(computer)}
                  className="relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-2.5 pr-7 text-xs outline-none data-[highlighted]:bg-muted data-[state=checked]:font-medium"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{computer.label}</span>
                  <DropdownMenu.ItemIndicator className="absolute right-2 inline-flex">
                    <Check className="size-3.5" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
          <DropdownMenu.Item
            onSelect={() => {
              newRemoteProjectPending.current = true;
              setOpen(false);
            }}
            className="flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-xs outline-none data-[highlighted]:bg-muted"
          >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            New remote project…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
