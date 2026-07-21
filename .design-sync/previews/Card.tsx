import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "pampalo";

export const Basic = () => (
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>Monthly shield cap</CardTitle>
      <CardDescription>
        How much you can move private this month.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p className="font-serif text-2xl text-ink">$2,400 remaining</p>
      <p className="text-sm text-ink-mute">of $5,000 · resets Aug 1</p>
    </CardContent>
  </Card>
);

export const WithFooterAndAction = () => (
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>Recovery phrase</CardTitle>
      <CardDescription>Back up your 12 words somewhere safe.</CardDescription>
      <CardAction>
        <Button variant="outline" size="sm">
          Reveal
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-ink-soft">
        Anyone with these words can spend your private balance. Pampalo never
        stores them in plaintext.
      </p>
    </CardContent>
    <CardFooter className="justify-end gap-2">
      <Button variant="ghost" size="sm">
        Later
      </Button>
      <Button size="sm">I saved it</Button>
    </CardFooter>
  </Card>
);

export const Small = () => (
  <Card size="sm" className="max-w-xs">
    <CardHeader>
      <CardTitle>Gas sponsor</CardTitle>
      <CardDescription>Base · 0.002 ETH available</CardDescription>
    </CardHeader>
  </Card>
);
