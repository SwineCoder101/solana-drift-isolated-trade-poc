import { FormEvent } from 'react';
import { OrderSide } from '../types/trading';

interface OrderFormProps {
  assets: string[];
  asset: string;
  side: OrderSide;
  leverage: number;
  initialAmount: string;
  submitting: boolean;
  status: string | null;
  address: string;
  onAssetChange: (value: string) => void;
  onSideChange: (value: OrderSide) => void;
  onLeverageChange: (value: number) => void;
  onAmountChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}

export function OrderForm({
  assets,
  asset,
  side,
  leverage,
  initialAmount,
  submitting,
  status,
  address,
  onAssetChange,
  onSideChange,
  onLeverageChange,
  onAmountChange,
  onSubmit,
}: OrderFormProps) {
  return (
    <section className="card order-card">
      <h2>Order Parameters (Admin Wallet)</h2>
      <form onSubmit={onSubmit} className="form-grid">
        <label>
          Market
          <select value={asset} onChange={(e) => onAssetChange(e.target.value)}>
            {assets.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </label>

        <label>
          Side
          <select value={side} onChange={(e) => onSideChange(e.target.value as OrderSide)}>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>

        <label>
          Leverage
          <input
            type="number"
            min="1"
            max="25"
            step="0.1"
            value={leverage}
            onChange={(e) => onLeverageChange(Number(e.target.value))}
          />
        </label>

        <label>
          Margin Amount
          <input
            type="number"
            min="0"
            step="0.01"
            value={initialAmount}
            onChange={(e) => onAmountChange(e.target.value)}
          />
        </label>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting...' : 'Submit Order'}
        </button>
      </form>
    </section>
  );
}
