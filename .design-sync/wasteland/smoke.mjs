import { chromium } from 'playwright-core'
import { readFileSync } from 'fs'

const token = readFileSync('backend/.env', 'utf8').trim().split('=')[1]
const exe = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1208\\chrome-win\\chrome.exe'
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

await page.goto('http://127.0.0.1:8734/login')
await page.waitForTimeout(2500)
await page.screenshot({ path: '.design-sync/wasteland/shot-login.png' })

await page.addInitScript((t) => localStorage.setItem('agentos_token', t), token)
for (const [route, name] of [['/', 'console'], ['/board', 'board'], ['/chat', 'chat'], ['/skills', 'skills'], ['/memory', 'memory'], ['/approvals', 'vault']]) {
  await page.goto('http://127.0.0.1:8734' + route)
  await page.waitForTimeout(1800)
  await page.screenshot({ path: `.design-sync/wasteland/shot-${name}.png` })
}
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await browser.close()
console.log('screenshots done; pageerrors:', errors.length)
