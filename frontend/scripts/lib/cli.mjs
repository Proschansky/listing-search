/**
 * `npm run pr:evidence`: record e2e evidence and (optionally) attach it to the PR.
 *
 * @remarks
 * Steps:
 *
 * 1. **Pick specs.** Files changed on this branch (against `--base`, default
 *    `main`) decide which e2e specs run: every test in each changed spec
 *    file. If no spec file changed, nothing is recorded and the PR is left
 *    untouched (`--all` overrides this). See `pickSpecs`.
 * 2. **Record.** Runs Playwright with `PW_EVIDENCE_DIR` set. The `evidence`
 *    fixture in `e2e/fixtures.ts` then saves, per test, screenshots of the UI,
 *    every `/api` request and response (status, timing, `X-Request-ID`, body),
 *    and a DevTools-style network panel rendered from them.
 * 3. **Preview.** Writes `frontend/pr-evidence/EVIDENCE.md`, which links the
 *    local images, so you can check it before publishing.
 * 4. **Publish** (`--publish`). Pushes the images to the `pr-evidence` branch
 *    under `pr-<number>/<commit>/`, then rewrites only the evidence section of
 *    the PR description with `gh pr edit`. Earlier evidence for other commits
 *    stays on the branch, so old links keep working.
 *    `--create` first opens a draft PR from the template if the branch has none.
 *
 * Images live on a separate orphan branch so they never enter the code
 * history or the PR's diff. GitHub's API has no endpoint for uploading
 * images to a PR description, and committed images (viewed through
 * `blob/...?raw=true` URLs) work for private repositories too.
 *
 * All process calls go through `deps.exec`, so `cli.test.mjs` can verify the
 * whole flow without git, GitHub or a browser.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvidenceMarkdown, pickSpecs, replaceEvidenceBlock } from './evidence.mjs'

/** Orphan branch that stores the evidence images. */
export const ASSETS_BRANCH = 'pr-evidence'

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: Record<string, string>, inherit?: boolean }) => ExecResult} Exec
 */

/** @type {Exec} Run a command synchronously. `inherit` streams its output to the terminal. */
export const realExec = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error) : '') }
}

/**
 * Parse command-line flags. Anything after `--` goes to Playwright.
 *
 * @param {string[]} argv
 * @returns {{ publish: boolean, create: boolean, all: boolean, base: string, extra: string[] }}
 */
export function parseArgs(argv) {
  const opts = { publish: false, create: false, all: false, base: 'main', extra: /** @type {string[]} */ ([]) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      opts.extra = argv.slice(i + 1)
      break
    } else if (a === '--publish') opts.publish = true
    else if (a === '--create') opts.create = opts.publish = true
    else if (a === '--all') opts.all = true
    else if (a === '--base') opts.base = argv[++i] ?? 'main'
    else
      throw new Error(`Unknown option ${a}. Use --publish, --create, --all, --base <branch>, or -- <playwright args>.`)
  }
  return opts
}

/**
 * Every file this branch changes: committed since it left `base`, plus
 * uncommitted and untracked work.
 *
 * @param {Exec} exec
 * @param {string} root - Repo root.
 * @param {string} base - Base branch.
 * @returns {string[]}
 */
export function changedFiles(exec, root, base) {
  const out = new Set()
  const add = (/** @type {ExecResult} */ r) =>
    r.code === 0 &&
    r.stdout
      .split('\n')
      .filter(Boolean)
      .forEach((f) => out.add(f))
  // Prefer the remote base (what the PR is compared against), then a local one.
  const mergeBase = [`origin/${base}`, base]
    .map((ref) => exec('git', ['merge-base', 'HEAD', ref], { cwd: root }))
    .find((r) => r.code === 0)
  if (mergeBase) add(exec('git', ['diff', '--name-only', mergeBase.stdout.trim(), 'HEAD'], { cwd: root }))
  add(exec('git', ['diff', '--name-only', 'HEAD'], { cwd: root }))
  add(exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root }))
  return [...out]
}

/**
 * Read every test's `evidence.json` written by the fixture.
 *
 * @param {string} runDir
 * @returns {import('./evidence.mjs').EvidenceTest[]}
 */
export function readManifests(runDir) {
  if (!existsSync(runDir)) return []
  return readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runDir, d.name, 'evidence.json')))
    .map((d) => JSON.parse(readFileSync(join(runDir, d.name, 'evidence.json'), 'utf8')))
    .sort((a, b) => `${a.file} ${a.title}`.localeCompare(`${b.file} ${b.title}`))
}

/**
 * Fail with a readable message if a command didn't succeed.
 *
 * @param {ExecResult} res
 * @param {string} what - What was being attempted.
 * @returns {ExecResult}
 */
function check(res, what) {
  if (res.code !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`)
  return res
}

/**
 * Commit `runDir` to the assets branch under `dest` and push it.
 *
 * @remarks
 * Uses a temporary `git worktree`, so your working copy, index and current
 * branch are never touched. The commit and push skip the repo's hooks
 * (`--no-verify`): this branch holds only images and JSON, never code, and the
 * code checks would otherwise run again for every evidence upload.
 *
 * @param {Exec} exec
 * @param {string} root
 * @param {string} runDir
 * @param {string} dest - e.g. `pr-12/abc1234`.
 * @param {string} message - Commit message.
 */
export function pushAssets(exec, root, runDir, dest, message) {
  const wt = mkdtempSync(join(tmpdir(), 'pr-evidence-'))
  const git = (/** @type {string[]} */ args, what = `git ${args[0]}`) => check(exec('git', args, { cwd: wt }), what)
  try {
    const exists =
      exec('git', ['ls-remote', '--exit-code', '--heads', 'origin', ASSETS_BRANCH], { cwd: root }).code === 0
    if (exists) {
      check(exec('git', ['fetch', 'origin', ASSETS_BRANCH], { cwd: root }), 'fetching the evidence branch')
      check(exec('git', ['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], { cwd: root }), 'creating a worktree')
    } else {
      // First upload: start an orphan branch with no code in its history.
      check(exec('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: root }), 'creating a worktree')
      git(['checkout', '--orphan', `${ASSETS_BRANCH}-new`])
      git(['rm', '-rf', '--quiet', '.'])
      writeFileSync(
        join(wt, 'README.md'),
        '# PR evidence\n\nScreenshots and network captures attached to pull requests by `npm run pr:evidence`. Not code; safe to prune old folders.\n',
      )
    }
    cpSync(runDir, join(wt, dest), { recursive: true })
    git(['add', '-A'])
    git(
      [
        '-c',
        'user.name=pr-evidence',
        '-c',
        'user.email=pr-evidence@users.noreply.github.com',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        message,
      ],
      'committing evidence',
    )
    git(['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${ASSETS_BRANCH}`], 'pushing evidence')
  } finally {
    exec('git', ['worktree', 'remove', '--force', wt], { cwd: root })
    rmSync(wt, { recursive: true, force: true })
  }
}

/**
 * Find this branch's PR, creating a draft from the template if asked.
 *
 * @param {Exec} exec
 * @param {string} root
 * @param {boolean} create
 * @returns {{ number: number, body: string, url: string }}
 */
export function findOrCreatePr(exec, root, create) {
  const view = () => exec('gh', ['pr', 'view', '--json', 'number,body,url'], { cwd: root })
  let res = view()
  if (res.code !== 0) {
    if (!create) throw new Error('This branch has no pull request yet. Open one first, or run `npm run pr:create`.')
    const title = check(
      exec('git', ['log', '-1', '--pretty=%s'], { cwd: root }),
      'reading the last commit',
    ).stdout.trim()
    check(
      exec(
        'gh',
        ['pr', 'create', '--draft', '--title', title, '--body-file', join(root, '.github', 'pull_request_template.md')],
        { cwd: root, inherit: true },
      ),
      'creating the pull request',
    )
    res = check(view(), 'reading the new pull request')
  }
  return JSON.parse(res.stdout)
}

/**
 * The whole command.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @param {{ exec?: Exec, log?: (msg: string) => void }} [deps]
 * @returns {number} Exit code.
 */
export function main(argv, { exec = realExec, log = console.log } = {}) {
  try {
    const opts = parseArgs(argv)
    const root = check(exec('git', ['rev-parse', '--show-toplevel']), 'finding the repository').stdout.trim()
    const frontend = join(root, 'frontend')
    const outDir = join(frontend, 'pr-evidence')
    const runDir = join(outDir, 'run')
    // Start clean, so evidence from an earlier run can't leak into this one.
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })

    // Step 1: pick specs. No changed spec file means nothing to show: skip
    // recording and leave the PR description exactly as it is.
    const pick = pickSpecs(changedFiles(exec, root, opts.base), { all: opts.all })
    if (pick.skip) {
      log(`No e2e spec changed on this branch, so no evidence was recorded${opts.publish ? ' or attached' : ''}.`)
      log('Use `npm run pr:evidence -- --all` to record every spec anyway.')
      // `pr:create` still opens the PR; it just has no evidence to attach.
      if (opts.create) {
        check(exec('gh', ['auth', 'status'], { cwd: root }), 'checking GitHub login (run `gh auth login`)')
        log(`Pull request: ${findOrCreatePr(exec, root, true).url}`)
      }
      return 0
    }
    log(`Recording e2e evidence for ${pick.reason}…`)

    // Step 2: record. Desktop only: one consistent viewport for review.
    const pwArgs = ['playwright', 'test', '--project=desktop', '--reporter=list', ...pick.specs, ...opts.extra]
    const pw = exec('npx', pwArgs, { cwd: frontend, env: { PW_EVIDENCE_DIR: runDir }, inherit: true })

    // Step 3: local preview.
    const tests = readManifests(runDir)
    // A brand-new repo has no commit yet; label the evidence rather than fail.
    const head = exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    const commit = head.code === 0 ? head.stdout.trim() : 'uncommitted'
    const markdown = (/** @type {(p: string) => string} */ imageUrl) =>
      buildEvidenceMarkdown({ tests, imageUrl, reason: pick.reason, commit })
    writeFileSync(
      join(outDir, 'EVIDENCE.md'),
      markdown((p) => `run/${p}`),
    )
    log(`Evidence for ${tests.length} test(s) written to frontend/pr-evidence/EVIDENCE.md`)
    if (!tests.length) throw new Error('No evidence was recorded. Check the Playwright output above.')
    if (pw.code !== 0) log('Some tests failed; their evidence is marked ❌ and opened by default.')

    if (!opts.publish) {
      log('Preview it, then run `npm run pr:evidence:publish` to attach it to the PR.')
      return pw.code === 0 ? 0 : 1
    }

    // Step 4: publish.
    check(exec('gh', ['auth', 'status'], { cwd: root }), 'checking GitHub login (run `gh auth login`)')
    const repo = check(
      exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: root }),
      'reading the repository',
    ).stdout.trim()
    const pr = findOrCreatePr(exec, root, opts.create)
    const dest = `pr-${pr.number}/${commit}`
    pushAssets(exec, root, runDir, dest, `Evidence for PR #${pr.number} at ${commit}`)
    const section = markdown((p) => `https://github.com/${repo}/blob/${ASSETS_BRANCH}/${dest}/${p}?raw=true`)
    const bodyFile = join(outDir, 'pr-body.md')
    writeFileSync(bodyFile, replaceEvidenceBlock(pr.body ?? '', section))
    check(
      exec('gh', ['pr', 'edit', String(pr.number), '--body-file', bodyFile], { cwd: root }),
      'updating the PR description',
    )
    log(`Evidence attached to ${pr.url}`)
    return pw.code === 0 ? 0 : 1
  } catch (err) {
    log(`pr:evidence: ${/** @type {Error} */ (err).message}`)
    return 1
  }
}
