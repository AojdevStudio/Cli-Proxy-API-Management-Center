import process from 'node:process';

try {
  const { explore } = await import('./explore');
  const report = await explore();
  console.log(JSON.stringify(report, null, 2));
  if (
    report.results.some((result) => result.properties.some((property) => property.counterexample))
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}
