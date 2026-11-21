#!/usr/bin/env node
/**
 * Entry point for `npm run pr:evidence` (see `lib/cli.mjs` for what it does).
 *
 *   npm run pr:evidence                 record the changed spec files, preview in frontend/pr-evidence/EVIDENCE.md
 *   npm run pr:evidence:publish         ...and attach it to this branch's PR
 *   npm run pr:create                   open a draft PR from the template, then attach evidence
 *   npm run pr:evidence -- --all        cover every spec, not just the changed ones
 *
 * If no e2e spec file changed, nothing is recorded and the PR is left as is.
 *   npm run pr:evidence -- -- --grep drawer   pass extra arguments to Playwright
 *
 * @module
 */
import { main } from './lib/cli.mjs'

process.exit(main(process.argv.slice(2)))
