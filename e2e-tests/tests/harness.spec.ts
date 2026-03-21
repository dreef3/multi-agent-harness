import { test, expect } from '@playwright/test';

test.describe('Multi-Agent Harness E2E', () => {
  test('create project and run free form request', async ({ page }) => {
    // Navigate to the home page
    await page.goto('/');
    
    // Wait for the dashboard to load
    await expect(page.getByText('Multi-Agent Harness')).toBeVisible();
    
    // Click on "New Project" link
    await page.getByRole('main').getByRole('link', { name: /\+ new project/i }).click();
    
    // Wait for the new project form
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();
    
    // Fill in project details
    const projectName = `E2E Test Project ${Date.now()}`;
    await page.getByLabel(/project name/i).fill(projectName);
    
    // Fill in description with a free form request
    await page.getByLabel(/description/i).fill('Please analyze the codebase structure and tell me what you find');
    
    // Submit the form
    await page.getByRole('button', { name: /create project/i }).click();
    
    // Wait to be redirected to the chat page
    await expect(page).toHaveURL(/\/projects\/\d+\/chat/);
    
    // Wait for chat interface to load
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });
    
    // Type a free form request
    const testMessage = 'List the files in the root directory of this repository';
    await page.getByPlaceholder(/type your message/i).fill(testMessage);
    
    // Send the message
    await page.getByRole('button', { name: /send/i }).click();
    
    // Wait for the user's message to appear in the chat
    await expect(page.locator('.bg-blue-600').filter({ hasText: testMessage })).toBeVisible({ timeout: 5000 });
    
    // Wait for agent response (with longer timeout since it involves AI)
    // The assistant messages have bg-gray-800 class
    const assistantMessages = page.locator('.bg-gray-800');
    await expect(assistantMessages.first()).toBeVisible({ timeout: 120000 });
    
    // Verify the response contains some content
    const responseText = await assistantMessages.first().textContent();
    expect(responseText).toBeTruthy();
    expect(responseText!.length).toBeGreaterThan(0);
    
    // Take a screenshot for verification
    await page.screenshot({ path: 'test-results/e2e-success.png', fullPage: true });
  });
  
  test('health check', async ({ request }) => {
    // Test the backend health endpoint
    const response = await request.get('http://localhost:3000/api/health');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});
