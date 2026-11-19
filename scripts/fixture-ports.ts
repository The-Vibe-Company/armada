export const developmentFixture = {
  dashboardPort: 3100,
  mockPort: 54399,
};

export const e2eFixture = {
  dashboardPort: 3101,
  mockPort: 54400,
};

export function fixtureOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
