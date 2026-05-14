import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement>;

export const PrimaryButton = React.forwardRef<HTMLButtonElement, Props>(
  function PrimaryButton({ className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          "cta-orange",
          "inline-flex h-14 w-full items-center justify-center gap-2",
          "rounded-full text-[15.5px] font-bold font-sans",
          "transition-all disabled:opacity-60 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/50",
          className,
        )}
      >
        {children}
      </button>
    );
  },
);
