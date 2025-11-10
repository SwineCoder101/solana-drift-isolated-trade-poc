export type OrderSide = 'long' | 'short';

export type TokenBalance = {
  symbol: string;
  mint: string;
  balance: number;
};

export type AccountSummary = {
  address: string;
  sol_balance: number;
  tokens: TokenBalance[];
};

export type BalancesResponse = {
  wallet: AccountSummary;
  drift_account: AccountSummary;
};

export type PositionRow = {
  market: string;
  positionSize: number;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number;
  leverage: number | null;
  liquidationPrice: number | null;
};

export type ServiceStatus = 'up' | 'down' | 'checking';
