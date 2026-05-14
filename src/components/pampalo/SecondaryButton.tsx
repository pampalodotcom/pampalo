import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement>;

export const SecondaryButton = React.forwardRef<HTMLButtonElement, Props>(
  function SecondaryButton({ className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          "inline-flex h-14 w-full items-center justify-center gap-2",
          "rounded-full bg-transparent border-[1.5px] border-line text-ink",
          "text-[15.5px] font-bold font-sans",
          "transition-all hover:bg-paper-lo disabled:opacity-60 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
          className,
        )}
      >
        {children}
      </button>
    );
  },
);
