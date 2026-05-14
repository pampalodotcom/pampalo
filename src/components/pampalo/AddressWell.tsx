import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function AddressWell({
  address,
  className,
}: {
  address: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast("Address copied", { duration: 2000 });
    } catch {
      toast.error("Couldn’t copy. Long-press to copy manually.");
    }
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-2xl bg-paper-lo border border-line px-3.5 py-3",
        className,
      )}
    >
      <code className="mono-addr flex-1">{address}</code>
      <button
        type="button"
        onClick={onCopy}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full",
          "border border-line bg-card px-3 py-1.5 text-[12px] font-semibold text-ink",
          "transition-colors hover:bg-paper-lo",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
        )}
        aria-label="Copy address"
      >
        {copied ? (
          <>
            <Check className="size-3.5" /> Copied
          </>
        ) : (
          <>
            <Copy className="size-3.5" /> Copy
          </>
        )}
      </button>
    </div>
  );
}
