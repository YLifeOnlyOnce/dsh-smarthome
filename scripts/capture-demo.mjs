#!/usr/bin/env node
/**
 * Capture README screenshots of docs/demo.html using the locally installed
 * Chrome (puppeteer-core, no browser download). Usage:
 *   node scripts/capture-demo.mjs [outDir]
 * Produces demo-start.png / demo-approval.png / demo-final.png.
 *
 * Each screenshot launches a fresh browser: this machine needs the
 * --single-process/--no-zygote combo, and reusing one browser across
 * navigations proved flaky under it.
 */
import puppeteer from 'puppeteer-core'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const outDir = process.argv[2] ?? `${process.cwd()}/docs/assets`
const demo = pathToFileURL(`${process.cwd()}/docs/demo.html`).href

await mkdir(outDir, { recursive: true })

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-crash-reporter',
  '--no-zygote',
  '--single-process',
  '--hide-scrollbars',
  '--no-first-run',
]

async function shot(name, hash, opts = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: LAUNCH_ARGS })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
    await page.goto(demo + hash, { waitUntil: 'domcontentloaded' })
    if (opts.waitText) {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        { timeout: 25000 },
        opts.waitText,
      )
    } else if (opts.waitSel) {
      await page.waitForSelector(opts.waitSel, { timeout: 15000 })
    }
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    await page.screenshot({ path: `${outDir}/${name}.png` })
    console.log('saved', `${outDir}/${name}.png`)
  } finally {
    await browser.close()
  }
}

await shot('demo-start', '', { delayMs: 2500 })
await shot('demo-approval', '#approval', { waitSel: '.modal-back.show', delayMs: 1500 })
await shot('demo-final', '#final', { waitText: '已批准并执行', delayMs: 1500 })

console.log('done')
