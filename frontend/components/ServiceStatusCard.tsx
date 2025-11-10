import { ServiceStatus } from '../types/trading';

function ServiceStatusBadge({ label, status }: { label: string; status: ServiceStatus }) {
  const color = status === 'up' ? 'green' : status === 'down' ? 'red' : 'gray';
  return (
    <div className="service-status">
      <span className="dot" style={{ backgroundColor: color }} />
      {label}: {status}
    </div>
  );
}

interface ServiceStatusCardProps {
  executionStatus: ServiceStatus;
  indexerStatus: ServiceStatus;
  refreshing: boolean;
  onRefresh: () => void;
}

export function ServiceStatusCard({ executionStatus, indexerStatus, refreshing, onRefresh }: ServiceStatusCardProps) {
  return (
    <section className="card status-card">
      <div className="status-card__header">
        <h2>Services</h2>
        <button type="button" onClick={onRefresh} disabled={refreshing} className="secondary">
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      <div className="status-grid">
        <ServiceStatusBadge label="Order Execution" status={executionStatus} />
        <ServiceStatusBadge label="Indexer" status={indexerStatus} />
      </div>
    </section>
  );
}
