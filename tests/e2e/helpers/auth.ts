import { type Page } from '@playwright/test';
import { TEST_USER, SEEDED_USER } from './constants';

/** Register a new user and return to the page (lands on /onboarding) */
export async function registerNewUser(page: Page) {
  await page.goto('/register');
  await page.getByTestId('register-name').fill(TEST_USER.name);
  await page.getByTestId('register-email').fill(TEST_USER.email);
  await page.getByTestId('register-password').fill(TEST_USER.password);
  await page.getByTestId('register-submit').click();
  await page.waitForURL('**/onboarding', { timeout: 10_000 });
}

/** Login with seeded user via API, inject tokens, navigate to /overview.
 *  Bypasses UI login entirely for maximum stability across test runs. */
export async function loginSeededUser(page: Page) {
  // 1. API login to get tokens
  const response = await page.request.post('http://localhost:3100/api/v1/auth/login', {
    data: { email: SEEDED_USER.email, password: SEEDED_USER.password },
  });
  const body = await response.json() as {
    data: { accessToken: string; user: { id: string; name: string; email: string }; refreshToken: string };
  };
  const token = body.data.accessToken;
  const user = body.data.user;
  const refreshToken = body.data.refreshToken;

  // 2. Get company list
  const companiesRes = await page.request.get('http://localhost:3100/api/v1/companies', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const companiesBody = await companiesRes.json() as { data: Array<{ id: string; name: string }> };
  const company = companiesBody.data[0];

  // 3. Inject auth + company state into localStorage (need a same-origin page first)
  await page.goto('/login');
  await page.evaluate(({ token, user, refreshToken, company }) => {
    localStorage.clear();
    localStorage.setItem('buildcrew_token', token);
    localStorage.setItem('buildcrew_user', JSON.stringify(user));
    localStorage.setItem('buildcrew_refresh_token', refreshToken);
    if (company) {
      localStorage.setItem('bc-company-id', company.id);
      localStorage.setItem('bc-company-name', company.name);
    }
  }, { token, user, refreshToken, company });

  // 4. Navigate to overview — AuthContext picks up injected token
  await page.goto('/overview');
  await page.waitForLoadState('networkidle');
}

/** Save auth state for reuse across tests */
export async function saveAuthState(page: Page, path: string) {
  await page.context().storageState({ path });
}
