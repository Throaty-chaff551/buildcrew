import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginSeededUser } from './helpers/auth';
import { SEEDED_USER } from './helpers/constants';

/** Helper: login via API and return token + companyId */
async function apiLogin(request: APIRequestContext) {
  const loginRes = await request.post('http://localhost:3100/api/v1/auth/login', {
    data: { email: SEEDED_USER.email, password: SEEDED_USER.password },
  });
  const body = await loginRes.json() as { data: { accessToken: string; user: { id: string } } };
  const token = body.data.accessToken;

  const companiesRes = await request.get('http://localhost:3100/api/v1/companies', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const companiesBody = await companiesRes.json() as { data: Array<{ id: string }> };
  const companyId = companiesBody.data[0]?.id;

  return { token, companyId };
}

/**
 * Bug regression tests using seeded user (TestCorp — has agents, goals, tasks, executed thread).
 */
test.describe('Bug Regression Tests', () => {
  test.beforeEach(async ({ page }) => {
    await loginSeededUser(page);
  });

  // === Bug #4: Aria department ===
  test('Bug #4: Aria agent department is executive', async ({ request }) => {
    const { token, companyId } = await apiLogin(request);
    expect(companyId).toBeTruthy();

    const agentsRes = await request.get(`http://localhost:3100/api/v1/companies/${companyId}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const agentsData = await agentsRes.json() as { data: Array<{ title: string; department: string }> };
    const ceo = agentsData.data.find((a) => a.title?.toLowerCase().includes('ceo'));
    expect(ceo).toBeTruthy();
    expect(ceo!.department).toBe('executive');
  });

  // === Bug #6: Chat list loads ===
  test('Bug #6: Chat threads list loads without error', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    const sidebar = page.getByTestId('chat-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
  });

  // === Bug #11 & #20: No 401 on refresh ===
  test('Bug #11 #20: No 401 errors on page refresh', async ({ page }) => {
    await page.goto('/overview');
    await page.waitForLoadState('networkidle');

    const errors401: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 401) {
        errors401.push(response.url());
      }
    });

    // Reload overview
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('overview-page')).toBeVisible({ timeout: 10_000 });
    expect(errors401).toHaveLength(0);

    // Clear and check /chat
    errors401.length = 0;
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: 10_000 });
    expect(errors401).toHaveLength(0);
  });

  // === Bug #18: Goal task count ===
  test('Bug #18: Goals have correct task count', async ({ request }) => {
    const { token, companyId } = await apiLogin(request);

    const goalsRes = await request.get(`http://localhost:3100/api/v1/companies/${companyId}/goals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const goalsData = await goalsRes.json() as { data: Array<{ id: string; task_count?: number; completed_task_count?: number }> };

    for (const goal of goalsData.data) {
      expect(goal.task_count).toBeGreaterThanOrEqual(0);
      expect(goal.completed_task_count).toBeGreaterThanOrEqual(0);
      expect(goal.task_count).toBeGreaterThanOrEqual(goal.completed_task_count!);
    }
  });

  // === Bug #22: Executed message has no button ===
  test('Bug #22: Executed plan message shows no execute button', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    const sidebar = page.getByTestId('chat-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const firstConvo = sidebar.locator('button').first();
    if (await firstConvo.isVisible()) {
      await firstConvo.click();
      await expect(page.getByTestId('chat-messages')).toBeVisible({ timeout: 10_000 });

      const executeBtn = page.getByTestId('chat-execute-btn');
      await expect(executeBtn).toBeHidden({ timeout: 5_000 });

      // Reload and verify again
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('chat-messages')).toBeVisible({ timeout: 10_000 });
      await expect(executeBtn).toBeHidden({ timeout: 5_000 });
    }
  });

  // === Bug #22: API level verification ===
  test('Bug #22: API returns executed metadata correctly', async ({ request }) => {
    const { token, companyId } = await apiLogin(request);

    const threadRes = await request.get(`http://localhost:3100/api/v1/companies/${companyId}/chat/active-thread`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (threadRes.ok()) {
      const threadBody = await threadRes.json() as { data: { thread: { id: string }; messages: Array<{ metadata?: { action_type?: string } }> } };
      const actionMessages = threadBody.data.messages.filter((m) => m.metadata?.action_type);
      for (const msg of actionMessages) {
        expect(msg.metadata!.action_type).not.toBe('ready_to_execute');
      }
    }
  });

  // === Overview data integrity ===
  test('Overview shows correct agent, goal, task counts', async ({ page }) => {
    await expect(page.getByTestId('overview-page')).toBeVisible({ timeout: 10_000 });

    // Wait for CompanyContext to load and stat cards to appear (async data)
    await page.waitForLoadState('networkidle');
    await page.getByTestId('overview-stat-agents').waitFor({ state: 'visible', timeout: 15_000 });

    // Agent count should be 5 (1 CEO + 4 hired)
    const agentText = await page.getByTestId('overview-stat-agents').getByTestId('stat-value').textContent();
    const agentCount = parseInt(agentText ?? '0', 10);
    expect(agentCount).toBe(5);

    // Task count should be >= 0
    const taskText = await page.getByTestId('overview-stat-tasks').getByTestId('stat-value').textContent();
    const taskCount = parseInt(taskText ?? '0', 10);
    expect(taskCount).toBeGreaterThanOrEqual(0);
  });

  // === No console errors on main pages ===
  test('No console errors on main pages', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore known non-functional errors
        if (text.includes('ResizeObserver') || text.includes('favicon')) return;
        if (text.includes('Failed to fetch')) return; // Navigation-caused fetch cancellations
        if (text.includes('Failed to load resource') && text.includes('404')) return; // Static resource 404s
        if (text.includes('Warning:')) return; // React development warnings
        if (text.includes('AbortError')) return; // Aborted requests during navigation
        consoleErrors.push(text);
      }
    });

    const pages = ['/overview', '/chat', '/agents', '/tasks', '/budget'];
    for (const p of pages) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
    }

    expect(consoleErrors).toHaveLength(0);
  });
});
