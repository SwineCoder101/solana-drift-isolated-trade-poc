'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export default function Header() {
  return (
    <header className="w-full border-b border-gray-200 dark:border-gray-800">
      <div className="container mx-auto px-4 py-4 flex justify-between items-center">
        <div className="flex items-center">
          <h1 className="text-2xl font-bold text-black dark:text-white">
            Solana Drift POC
          </h1>
        </div>
        <nav className="flex items-center gap-4">
          <WalletMultiButton />
        </nav>
      </div>
    </header>
  );
}
