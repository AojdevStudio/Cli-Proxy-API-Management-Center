import { useThemeStore } from '@/stores';
import { useUsageData } from './hooks/useUsageData';
import { UsageView } from './UsageView';

export function UsagePage() {
  const theme = useThemeStore((state) => state.resolvedTheme);
  const data = useUsageData();
  return (
    <UsageView
      now={data.now}
      theme={theme}
      logins={data.logins}
      loginsLoading={data.loginsLoading}
      loginsError={data.loginsError}
      reader={data.reader}
      turns={data.turns}
      refreshing={data.refreshing}
      onRefresh={data.refresh}
      onSessionsOpen={data.loadTurns}
    />
  );
}
