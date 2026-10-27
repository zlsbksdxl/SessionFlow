import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function CopyPromptButton({ content }: { content: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    mountedRef.current = true;
    requestRef.current += 1;
    setStatus('idle');
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [content]);

  const copyPrompt = async () => {
    const request = ++requestRef.current;
    const isCurrent = () => mountedRef.current && requestRef.current === request && contentRef.current === content;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setStatus('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(content);
      if (!isCurrent()) return;
      setStatus('copied');
      timerRef.current = window.setTimeout(() => {
        if (isCurrent()) setStatus('idle');
        timerRef.current = undefined;
      }, 1_500);
    } catch {
      if (isCurrent()) setStatus('failed');
    }
  };

  const label = status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed. Try again.' : 'Copy prompt';

  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 text-muted-foreground hover:text-foreground"
            aria-label={label}
            onClick={() => void copyPrompt()}
          >
            {status === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {status === 'failed' ? (
        <span role="status" data-copy-error="true" className="text-xs text-destructive">
          Copy failed. Try again.
        </span>
      ) : null}
    </span>
  );
}
