import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Radix `Dialog` powers both this and the regular Dialog primitive — a
// "sheet" is just a dialog with edge-anchored positioning, slide-in
// animation, and a drag-affordance pill on top. We expose the same
// sub-components (Root/Trigger/Content/etc.) so callers can swap a
// Dialog for a Sheet (or pick at runtime) without rewriting the body.

function Sheet({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/30 duration-150 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

type SheetSide = "top" | "bottom" | "left" | "right";

const sideStyles: Record<SheetSide, string> = {
  bottom:
    "inset-x-0 bottom-0 max-h-[90dvh] overflow-hidden rounded-t-3xl border-t data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
  top:
    "inset-x-0 top-0 max-h-[90dvh] overflow-hidden rounded-b-3xl border-b data-open:slide-in-from-top data-closed:slide-out-to-top",
  left:
    "inset-y-0 left-0 h-full w-[85%] max-w-sm rounded-r-3xl border-r data-open:slide-in-from-left data-closed:slide-out-to-left",
  right:
    "inset-y-0 right-0 h-full w-[85%] max-w-sm rounded-l-3xl border-l data-open:slide-in-from-right data-closed:slide-out-to-right",
};

function SheetContent({
  className,
  children,
  side = "bottom",
  showCloseButton = true,
  showDragHandle,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: SheetSide;
  showCloseButton?: boolean;
  /** Drag-affordance pill at the top of the sheet. Defaults to true for
   *  bottom sheets (matches iOS conventions), false otherwise. */
  showDragHandle?: boolean;
}) {
  const wantHandle = showDragHandle ?? side === "bottom";

  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col gap-0 bg-popover text-popover-foreground ring-1 ring-foreground/10 outline-none duration-200 data-open:animate-in data-closed:animate-out",
          sideStyles[side],
          className,
        )}
        {...props}
      >
        {wantHandle && (
          <div className="flex shrink-0 justify-center pt-2.5">
            <div
              aria-hidden
              className="h-1.5 w-9 rounded-full bg-foreground/15"
            />
          </div>
        )}

        {/* Scroll region: lets tall bodies (e.g. the shielded deposit
         *  step with extra address rows) scroll *inside* the sheet
         *  instead of pushing it past the viewport, which would scroll
         *  the close button off-screen and trap the user. The drag
         *  handle above and the absolutely-positioned close button stay
         *  pinned because they live outside this overflow container. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {children}
        </div>

        {showCloseButton && (
          <DialogPrimitive.Close data-slot="sheet-close" asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-2 px-5 pt-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-medium leading-none", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
