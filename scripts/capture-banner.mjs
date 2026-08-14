#!/usr/bin/env node
/**
 * Capture the particle-effect banner (docs/banner.html) as a high-res PNG
 * using the locally installed Chrome. Usage:
 *   node scripts/capture-banner.mjs [outFile]
 */
import puppeteer from 'puppeteer-core'
import { pathToFileURL } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const outFile = process.argv[2] ?? `${process.cwd()}/docs/assets/banner.png`
const pageUrl = pathToFileURL(`${process.cwd()}/docs/banner.html`).href

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-crash-reporter', '--no-zygote', '--single-process',
    '--hide-scrollbars', '--no-first-run',
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 })
await page.goto(pageUrl, { waitUntil: 'load' })
// Let the animation breathe so the particles/glows settle into a good frame.
await new Promise(r => setTimeout(r, 2600))
await page.screenshot({ path: outFile })
await browser.close()
console.log('saved', outFile)
