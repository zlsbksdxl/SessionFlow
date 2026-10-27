import { FileText, Image as ImageIcon, MessagesSquare, X } from 'lucide-react';
import { type ChatAttachment } from '@/shared/provider-runtime';
import { formatFileSize } from '@/lib/format';
import { chatContextAttachmentPrefix } from '@/lib/chat-context-attachment';

export function ComposerAttachmentPill({ attachment, disabled, onRemove }: { attachment: ChatAttachment; disabled?: boolean; onRemove: (id: string) => void }) {
  const chatContext = attachment.id.startsWith(chatContextAttachmentPrefix);
  return (
    <div className="group/attachment grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-ink-line bg-foreground/[0.04] px-2 py-2 font-mono">
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-line bg-ink-soft text-term-cyan">
        {chatContext ? (
          <MessagesSquare className="size-4" />
        ) : attachment.kind === 'image' && attachment.dataUrl ? (
          <img className="size-full object-cover" src={attachment.dataUrl} alt="" />
        ) : attachment.kind === 'image' ? (
          <ImageIcon className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-term-name">{attachment.name}</span>
        <span className="mt-0.5 block truncate text-[10.5px] text-term-dim2">
          {chatContext ? 'Chat context' : attachment.mediaType} · {formatFileSize(attachment.size)}
          {attachment.truncated ? (chatContext ? ' · recent messages only' : ' · truncated') : ''}
        </span>
      </span>
      <button
        type="button"
        className="rounded-md p-1 text-term-dim2 transition hover:bg-foreground/[0.06] hover:text-term-name disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        aria-label={`Remove ${attachment.name}`}
        onClick={() => onRemove(attachment.id)}
      >
        <X className="size-3.5" />
      </button>
      {chatContext && attachment.text ? (
        <details className="col-span-full min-w-0 text-term-dim2">
          <summary className="cursor-pointer text-[11px] outline-none focus-visible:underline">View included messages</summary>
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/50 p-2 text-[11px] leading-5">
            {attachment.text}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
