// Browser regression checks for the mobile Today experience (UM / SUPER_ADMIN).
//
// Isolated fixtures: HTML rendered from the real TodayPage by __tests__/unit/mobile/today-page.test.tsx
// (E2E_FIXTURE_DIR) plus the production Tailwind CSS from `next build`. No accounts, no network.
// Run: E2E_FIXTURE_DIR=.e2e-fixtures npx vitest run __tests__/unit/mobile && npm run build && npm run test:e2e

import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const FIXTURES = path.resolve(process.env.E2E_FIXTURE_DIR ?? '.e2e-fixtures')

function appCss(): string {
  const root = path.resolve('.next/static')
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.css')) out.push(fs.readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  if (!out.length) throw new Error('No built CSS under .next/static — run `npm run build` first')
  return out.join('\n')
}

async function open(page: Page, fixture: string, width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  const html = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${appCss()}</style></head><body>${html}</body></html>`)
}

const PHONE = 390
const DESKTOP = 1280

for (const fixture of ['today-um-default.html', 'today-um-management.html', 'today-admin-default.html']) {
  test.describe(`mobile Today — ${fixture}`, () => {
    test('phone shows Audit, KQC, My tasks (quick add) and Meetings (quick add)', async ({ page }) => {
      await open(page, fixture, PHONE)
      await expect(page.getByRole('link', { name: '+ Add Audit' })).toBeVisible()
      await expect(page.getByRole('link', { name: '+ Add KQC' })).toBeVisible()
      const tasks = page.getByTestId('mobile-my-tasks')
      await expect(tasks).toBeVisible()
      await expect(tasks.getByPlaceholder('Add a task...')).toBeVisible()
      const meetings = page.getByTestId('mobile-meetings')
      await expect(meetings).toBeVisible()
      await expect(meetings.getByText('Team sync')).toBeVisible()
    })

    test('phone hides the desktop dashboard grid; desktop hides the mobile blocks', async ({ page }) => {
      await open(page, fixture, PHONE)
      await expect(page.getByText('Urgent now')).toBeHidden()
      await open(page, fixture, DESKTOP)
      await expect(page.getByText('Urgent now')).toBeVisible()
      await expect(page.getByTestId('mobile-quick-actions')).toBeHidden()
      await expect(page.getByTestId('mobile-my-tasks')).toBeHidden()
    })

    test('phone shows no other user\'s items in personal lists', async ({ page }) => {
      await open(page, fixture, PHONE)
      await expect(page.getByTestId('mobile-my-tasks').getByText('MINE task one')).toBeVisible()
      await expect(page.getByTestId('mobile-my-tasks').getByText(/THEIRS/)).toHaveCount(0)
      await expect(page.getByText('THEIRS todo')).toHaveCount(0)
      await expect(page.getByText('THEIRS recurring')).toHaveCount(0)
    })
  })
}

test('desktop Management toggle stays available for managers', async ({ page }) => {
  await open(page, 'today-um-default.html', DESKTOP)
  await expect(page.getByRole('link', { name: 'Management' })).toBeVisible()
  await open(page, 'today-um-management.html', DESKTOP)
  await expect(page.getByText('THEIRS task alpha').first()).toBeVisible()
})

test('members get no manager mobile features', async ({ page }) => {
  await open(page, 'today-member.html', PHONE)
  await expect(page.getByTestId('mobile-quick-actions')).toHaveCount(0)
  await expect(page.getByTestId('mobile-my-tasks')).toHaveCount(0)
})
