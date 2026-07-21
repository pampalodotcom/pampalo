// design-sync bundle entry — presentational components only.
// App-wired components (Convex / router / useAuth coupled) are deliberately
// excluded so the design-system bundle stays renderable outside the app;
// see .design-sync/NOTES.md for the exclusion list.

// shadcn/radix primitives
export * from "../src/components/ui/badge";
export * from "../src/components/ui/button";
export * from "../src/components/ui/card";
export * from "../src/components/ui/dialog";
export * from "../src/components/ui/sheet";
export * from "../src/components/ui/sonner";
export * from "../src/components/ui/table";
export * from "../src/components/ui/tooltip";
export * from "../src/components/ui/animated-shiny-text";
export * from "../src/components/ui/typing-animation";

// pampalo brand components
export * from "../src/components/pampalo/AccountAvatar";
export * from "../src/components/pampalo/AddressPill";
export * from "../src/components/pampalo/AddressWell";
export * from "../src/components/pampalo/AssetMark";
export * from "../src/components/pampalo/AssetRow";
export * from "../src/components/pampalo/AssetSelect";
export * from "../src/components/pampalo/BalanceCard";
export * from "../src/components/pampalo/BeachScene";
export * from "../src/components/pampalo/BrandLockup";
export * from "../src/components/pampalo/GasTierPicker";
export * from "../src/components/pampalo/MnemonicReveal";
export * from "../src/components/pampalo/NetworkChip";
export * from "../src/components/pampalo/NetworkFilterTabs";
export * from "../src/components/pampalo/PageLoading";
export * from "../src/components/pampalo/PendingShieldsList";
export * from "../src/components/pampalo/PrimaryButton";
export * from "../src/components/pampalo/RecoverAccount";
export * from "../src/components/pampalo/ReviewSwap";
export * from "../src/components/pampalo/SecondaryButton";
export * from "../src/components/pampalo/SplitBar";
export * from "../src/components/pampalo/SplitSlider";
export * from "../src/components/pampalo/StatusDot";
export * from "../src/components/pampalo/SunMoonIcons";
export * from "../src/components/pampalo/ThemeToggle";
export * from "../src/components/pampalo/WarningChip";

// deposit / receive / send presentational pieces (flow containers excluded)
export * from "../src/components/pampalo/deposit/DepositButton";
export * from "../src/components/pampalo/deposit/DepositReceiveStep";
export * from "../src/components/pampalo/deposit/ModeSegmented";
export * from "../src/components/pampalo/deposit/NetworkCard";
export * from "../src/components/pampalo/deposit/NetworkLogo";
export * from "../src/components/pampalo/deposit/QRCanvas";
export * from "../src/components/pampalo/receive/ReceiveButton";
export * from "../src/components/pampalo/send/SendButton";

// theme context provider (preview wrapper; also how the app themes itself)
export { ThemeProvider } from "../src/lib/theme";

// sonner's imperative toast API — must come from the same module instance
// as the bundled <Toaster/>, so designs (and previews) fire toasts that the
// bundle's Toaster actually receives.
export { toast } from "sonner";
