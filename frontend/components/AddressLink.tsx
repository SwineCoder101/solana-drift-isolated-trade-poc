const EXPLORER_BASE = 'https://explorer.solana.com/address';

export const shortenAddress = (address: string) => {
  if (!address) return '';
  if (address.length <= 8) return address;
  return `${address.slice(0, 3)}...${address.slice(-4)}`;
};

export function AddressLink({ address }: { address: string }) {
  const href = `${EXPLORER_BASE}/${address}?cluster=devnet`;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={address}>
      {shortenAddress(address)}
    </a>
  );
}
