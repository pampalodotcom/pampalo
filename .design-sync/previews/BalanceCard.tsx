import { BalanceCard } from "pampalo";

export const Default = () => (
  <div style={{ width: 640 }}>
    <BalanceCard totalUsd={12483.52} publicUsd={4106.19} privateUsd={8377.33} />
  </div>
);

export const WithActions = () => (
  <div style={{ width: 640 }}>
    <BalanceCard
      totalUsd={12483.52}
      publicUsd={4106.19}
      privateUsd={8377.33}
      onSwap={() => {}}
      onSync={() => {}}
      onDeposit={() => {}}
      onReceive={() => {}}
      onSend={() => {}}
    />
  </div>
);

export const MostlyPrivate = () => (
  <div style={{ width: 640 }}>
    <BalanceCard totalUsd={5210.4} publicUsd={312.62} privateUsd={4897.78} />
  </div>
);

export const WithTestnetBalance = () => (
  <div style={{ width: 640 }}>
    <BalanceCard
      totalUsd={12483.52}
      publicUsd={4106.19}
      privateUsd={8377.33}
      testnetUsd={25.1}
    />
  </div>
);

export const Syncing = () => (
  <div style={{ width: 640 }}>
    <BalanceCard
      totalUsd={12483.52}
      publicUsd={4106.19}
      privateUsd={8377.33}
      onSync={() => {}}
      syncing
    />
  </div>
);

export const Loading = () => (
  <div style={{ width: 640 }}>
    <BalanceCard totalUsd={null} publicUsd={null} privateUsd={null} />
  </div>
);
