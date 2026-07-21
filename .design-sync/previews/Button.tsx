import { Button } from "pampalo";
import { ArrowRight, Copy, Trash2 } from "lucide-react";

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Confirm</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="destructive">
      <Trash2 data-icon="inline-start" />
      Remove
    </Button>
    <Button variant="link">Learn more</Button>
  </div>
);

export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button size="xs">Extra small</Button>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">
      Continue
      <ArrowRight data-icon="inline-end" />
    </Button>
    <Button size="icon" aria-label="Copy address">
      <Copy />
    </Button>
  </div>
);

export const Disabled = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button disabled>Confirm</Button>
    <Button variant="outline" disabled>
      Outline
    </Button>
    <Button variant="destructive" disabled>
      Remove
    </Button>
  </div>
);
