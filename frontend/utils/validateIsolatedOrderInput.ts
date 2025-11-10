/**
 * Validates inputs for opening an isolated perpetual position.
 *
 * @param size - Desired position size (positive = long, negative = short).
 * @param leverage - Target leverage multiple.
 * @param margin - Margin to lock in USDC (not a ratio).
 * @param oraclePrice - Current oracle price of the asset in USDC.
 * @returns Validation result with `valid` flag and optional error message.
 */
export function validateIsolatedOrderInput(
  size: number,
  leverage: number,
  margin: number,
  oraclePrice: number,
): { valid: true } | { valid: false; error: string } {
  const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : 'NaN');

  if (typeof size !== 'number' || Number.isNaN(size)) {
    return { valid: false, error: 'Invalid size: expected a number.' };
  }
  if (size === 0) {
    return { valid: false, error: 'Invalid size: must be non-zero.' };
  }

  if (typeof leverage !== 'number' || !Number.isFinite(leverage)) {
    return { valid: false, error: 'Invalid leverage: expected a finite number.' };
  }
  if (leverage < 1 || leverage > 10) {
    return { valid: false, error: 'Invalid leverage: must be between 1 and 10.' };
  }

  if (typeof margin !== 'number' || !Number.isFinite(margin)) {
    return { valid: false, error: 'Invalid margin: expected a finite number.' };
  }
  if (margin <= 0) {
    return { valid: false, error: 'Invalid margin: must be greater than 0.' };
  }

  if (typeof oraclePrice !== 'number' || !Number.isFinite(oraclePrice) || oraclePrice <= 0) {
    return { valid: false, error: 'Invalid oracle price: expected a positive number.' };
  }

  const requiredMargin = (Math.abs(size) * oraclePrice) / leverage;
  const minMargin = requiredMargin * 0.95; // allow 5% tolerance

  if (margin < minMargin) {
    return {
      valid: false,
      error: `Insufficient margin: need at least ${fmt(minMargin)} USDC for requested leverage (provided ${fmt(
        margin,
      )}).`,
    };
  }

  return { valid: true };
}
