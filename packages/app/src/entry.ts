// A packaged Electron app always starts its package main, so the headless browser helper is a mode of it.
if (process.argv.includes('--ted-headless-browser')) await import('./headless-browser.ts')
else await import('./main.ts')
