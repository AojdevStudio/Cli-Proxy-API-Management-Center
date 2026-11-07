import { useUsageData } from './hooks/useUsageData';
import { UsageView } from './UsageView';

export function UsagePage() {
  return <UsageView {...useUsageData()} />;
}
