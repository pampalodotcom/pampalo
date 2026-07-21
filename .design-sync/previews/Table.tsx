import {
  Badge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "pampalo";

export const RecentActivity = () => (
  <div style={{ width: 640 }}>
    <Table>
      <TableCaption>Recent activity across your accounts.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Action</TableHead>
          <TableHead>Network</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">Shield ETH</TableCell>
          <TableCell>Ethereum</TableCell>
          <TableCell className="text-right font-mono">0.5 ETH</TableCell>
          <TableCell className="text-right">
            <Badge variant="secondary">Confirmed</Badge>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">Send USDC</TableCell>
          <TableCell>Base</TableCell>
          <TableCell className="text-right font-mono">250.00 USDC</TableCell>
          <TableCell className="text-right">
            <Badge variant="outline">Pending</Badge>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">Unshield AUDD</TableCell>
          <TableCell>Base</TableCell>
          <TableCell className="text-right font-mono">1,000.00 AUDD</TableCell>
          <TableCell className="text-right">
            <Badge variant="destructive">Reverted</Badge>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
);

export const Balances = () => (
  <div style={{ width: 640 }}>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Asset</TableHead>
          <TableHead className="text-right">Public</TableHead>
          <TableHead className="text-right">Shielded</TableHead>
          <TableHead className="text-right">Value (USD)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">ETH</TableCell>
          <TableCell className="text-right font-mono">0.75</TableCell>
          <TableCell className="text-right font-mono">1.25</TableCell>
          <TableCell className="text-right font-mono">$6,368.40</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">USDC</TableCell>
          <TableCell className="text-right font-mono">1,840.50</TableCell>
          <TableCell className="text-right font-mono">0.00</TableCell>
          <TableCell className="text-right font-mono">$1,840.50</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">AUDD</TableCell>
          <TableCell className="text-right font-mono">0.00</TableCell>
          <TableCell className="text-right font-mono">3,200.00</TableCell>
          <TableCell className="text-right font-mono">$2,112.00</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Total</TableCell>
          <TableCell className="text-right font-mono">$10,320.90</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  </div>
);

export const SelectedRow = () => (
  <div style={{ width: 640 }}>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead>Address</TableHead>
          <TableHead className="text-right">Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">Everyday</TableCell>
          <TableCell className="font-mono">0x8f3C…9aD1</TableCell>
          <TableCell className="text-right font-mono">0.75 ETH</TableCell>
        </TableRow>
        <TableRow data-state="selected">
          <TableCell className="font-medium">Savings</TableCell>
          <TableCell className="font-mono">0x41bE…77c0</TableCell>
          <TableCell className="text-right font-mono">1.25 ETH</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
);
