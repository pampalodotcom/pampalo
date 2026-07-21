import { SplitSlider } from "pampalo";

export const EthEvenSplit = () => (
  <div style={{ width: 640 }}>
    <SplitSlider
      pub={1.0}
      total={2.0}
      originalPub={1.0}
      onChange={() => {}}
      decimals={4}
      ticker="ETH"
    />
  </div>
);

export const UsdcDraggedPrivate = () => (
  <div style={{ width: 640 }}>
    <SplitSlider
      pub={400}
      total={1840.5}
      originalPub={1840.5}
      onChange={() => {}}
      decimals={2}
      ticker="USDC"
    />
  </div>
);

export const CappedMinimum = () => (
  <div style={{ width: 640 }}>
    <SplitSlider
      pub={600}
      total={1000}
      originalPub={800}
      minPub={500}
      onChange={() => {}}
      decimals={2}
      ticker="AUDD"
    />
  </div>
);
