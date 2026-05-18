import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AccountModal } from "@/components/pampalo/AccountModal";

// Provider + hook so the account modal can be opened from anywhere
// (header avatar, sign-out shortcut, future quick-action menu).

type Ctx = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

const AccountModalContext = createContext<Ctx | null>(null);

export function AccountModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const value = useMemo<Ctx>(
    () => ({
      isOpen,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
    }),
    [isOpen],
  );
  return (
    <AccountModalContext.Provider value={value}>
      {children}
      <AccountModal open={isOpen} onOpenChange={setIsOpen} />
    </AccountModalContext.Provider>
  );
}

export function useAccountModal(): Ctx {
  const ctx = useContext(AccountModalContext);
  if (!ctx) {
    throw new Error("useAccountModal must be used inside AccountModalProvider");
  }
  return ctx;
}
