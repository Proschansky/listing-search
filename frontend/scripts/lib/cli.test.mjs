/**
 * Tests for the `pr:evidence` command, with git, gh and Playwright faked.
 *
 * @remarks
 * `fakeExec` plays the part of every external command. "Playwright" writes
 * a manifest into the run folder the way the e2e fixture would, so the tests
 * exercise the real file handling against a temporary repo root.
 *
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSETS_BRANCH, changedFiles, findOrCreatePr, main, parseArgs, pushAssets, readManifests } from './cli.mjs'
import { END_MARKER, START_MARKER } from './evidence.mjs'

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evidence-test-'))
  mkdirSync(join(root, 'frontend'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'nope') => ({ code: 1, stdout: '', stderr })

/** Write one test's manifest the way the e2e fixture does. */
function writeManifest(runDir, name, status = 'passed') {
  mkdirSync(join(runDir, name), { recursive: true })
  writeFileSync(join(runDir, name, '01-final.png'), 'png')
  writeFileSync(
    join(runDir, name, 'evidence.json'),
    JSON.stringify({
      title: name,
      file: 'e2e/search.spec.ts',
      status,
      dir: name,
      screenshots: [{ label: 'Final', file: '01-final.png' }],
      networkImage: 'network.png',
      network: [],
    }),
  )
}

/**
 * A fake for every command the CLI runs. `overrides` maps "cmd arg0 arg1" prefixes to results.
 */
function fakeExec(overrides = {}) {
  const calls = []
  const exec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts })
    const key = [cmd, ...args].join(' ')
    for (const [prefix, result] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) return typeof result === 'function' ? result(cmd, args, opts) : result
    }
    if (key === 'git rev-parse --show-toplevel') return ok(`${root}\n`)
    if (key.startsWith('git merge-base HEAD origin/main')) return ok('base123\n')
    if (key.startsWith('git diff --name-only base123')) return ok('frontend/e2e/search.spec.ts\n')
    if (key.startsWith('git diff --name-only HEAD')) return ok('frontend/src/App.tsx\n')
    if (key.startsWith('git ls-files')) return ok('')
    if (key.startsWith('npx playwright')) {
      writeManifest(opts.env.PW_EVIDENCE_DIR, 'search-filters')
      return ok()
    }
    if (key === 'git rev-parse --short HEAD') return ok('abc1234\n')
    if (key === 'gh auth status') return ok()
    if (key.startsWith('gh repo view')) return ok('acme/listing-search\n')
    if (key.startsWith('gh pr view'))
      return ok(
        JSON.stringify({
          number: 7,
          body: `Intro\n${START_MARKER}\nold\n${END_MARKER}`,
          url: 'https://github.com/acme/listing-search/pull/7',
        }),
      )
    if (key.startsWith('git ls-remote')) return fail()
    if (cmd === 'git' || cmd === 'gh') return ok()
    return fail(`unexpected ${key}`)
  }
  return { exec, calls }
}

const run = (argv, exec) => {
  const lines = []
  const code = main(argv, { exec, log: (m) => lines.push(m) })
  return { code, out: lines.join('\n') }
}

describe('parseArgs', () => {
  it('reads every flag and passes the rest to Playwright', () => {
    expect(parseArgs(['--publish', '--all', '--base', 'develop', '--', '--grep', 'drawer'])).toEqual({
      publish: true,
      create: false,
      all: true,
      base: 'develop',
      extra: ['--grep', 'drawer'],
    })
  })

  it('treats --create as create-and-publish, and defaults the base', () => {
    expect(parseArgs(['--create', '--base'])).toMatchObject({ create: true, publish: true, base: 'main' })
  })

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option --nope')
  })
})

describe('changedFiles', () => {
  it('combines branch commits, uncommitted and untracked files', () => {
    const { exec } = fakeExec({ 'git ls-files': ok('frontend/e2e/new.spec.ts\n') })
    expect(changedFiles(exec, root, 'main').sort()).toEqual([
      'frontend/e2e/new.spec.ts',
      'frontend/e2e/search.spec.ts',
      'frontend/src/App.tsx',
    ])
  })

  it('falls back to a local base, or skips the branch diff when there is none', () => {
    const local = fakeExec({ 'git merge-base HEAD origin/main': fail(), 'git merge-base HEAD main': ok('base123\n') })
    expect(changedFiles(local.exec, root, 'main')).toContain('frontend/e2e/search.spec.ts')
    const none = fakeExec({ 'git merge-base': fail(), 'git diff --name-only HEAD': fail() })
    expect(changedFiles(none.exec, root, 'main')).toEqual([])
  })
})

describe('readManifests', () => {
  it('returns nothing for a missing folder and reads manifests in a stable order', () => {
    expect(readManifests(join(root, 'missing'))).toEqual([])
    const runDir = join(root, 'run')
    writeManifest(runDir, 'b-test')
    writeManifest(runDir, 'a-test')
    mkdirSync(join(runDir, 'no-manifest'))
    expect(readManifests(runDir).map((t) => t.title)).toEqual(['a-test', 'b-test'])
  })
})

describe('main: local preview', () => {
  it('runs the changed specs with evidence on and writes a local preview', () => {
    const { exec, calls } = fakeExec()
    const { code, out } = run([], exec)
    expect(code).toBe(0)
    const pw = calls.find((c) => c.cmd === 'npx')
    expect(pw.args).toEqual(['playwright', 'test', '--project=desktop', '--reporter=list', 'e2e/search.spec.ts'])
    expect(pw.opts.env.PW_EVIDENCE_DIR).toBe(join(root, 'frontend', 'pr-evidence', 'run'))
    const md = readFileSync(join(root, 'frontend', 'pr-evidence', 'EVIDENCE.md'), 'utf8')
    expect(md).toContain('<img src="run/search-filters/01-final.png"')
    expect(out).toContain('npm run pr:evidence:publish')
    expect(calls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('passes extra args through to Playwright', () => {
    const { exec, calls } = fakeExec()
    run(['--', '--headed'], exec)
    expect(calls.find((c) => c.cmd === 'npx').args.slice(4)).toEqual(['e2e/search.spec.ts', '--headed'])
  })

  it('records nothing and touches no PR when no spec file changed', () => {
    const { exec, calls } = fakeExec({ 'git diff --name-only base123': ok('frontend/src/App.tsx\n') })
    const { code, out } = run(['--publish'], exec)
    expect(code).toBe(0)
    expect(out).toContain('No e2e spec changed on this branch, so no evidence was recorded or attached.')
    expect(calls.some((c) => c.cmd === 'npx')).toBe(false)
    expect(calls.some((c) => c.cmd === 'gh')).toBe(false)
    expect(existsSync(join(root, 'frontend', 'pr-evidence', 'EVIDENCE.md'))).toBe(false)
  })

  it('says only "recorded" (not "attached") for a local run with no changed specs', () => {
    const { exec } = fakeExec({ 'git diff --name-only base123': ok('') })
    expect(run([], exec).out).toContain('no evidence was recorded.')
  })

  it('records every spec with --all even when none changed', () => {
    const { exec, calls } = fakeExec({ 'git diff --name-only base123': ok('') })
    expect(run(['--all'], exec).code).toBe(0)
    expect(calls.find((c) => c.cmd === 'npx').args).toEqual([
      'playwright',
      'test',
      '--project=desktop',
      '--reporter=list',
    ])
  })

  it('pr:create still opens the PR when no spec changed, without evidence', () => {
    let created = false
    const { exec, calls } = fakeExec({
      'git diff --name-only base123': ok(''),
      'git log -1': ok('Docs tweak\n'),
      'gh pr create': () => ((created = true), ok()),
      'gh pr view': () => (created ? ok(JSON.stringify({ number: 11, body: '', url: 'https://pr/11' })) : fail()),
    })
    const { code, out } = run(['--create'], exec)
    expect(code).toBe(0)
    expect(out).toContain('Pull request: https://pr/11')
    expect(calls.some((c) => c.cmd === 'npx')).toBe(false)
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'edit')).toBe(false)
  })

  it('labels evidence from a repo with no commits yet', () => {
    const { exec } = fakeExec({ 'git rev-parse --short HEAD': fail('no HEAD') })
    run([], exec)
    expect(readFileSync(join(root, 'frontend', 'pr-evidence', 'EVIDENCE.md'), 'utf8')).toContain('`uncommitted`')
  })

  it('exits 1 but keeps the evidence when some tests failed', () => {
    const { exec } = fakeExec({
      'npx playwright': (_c, _a, opts) => {
        writeManifest(opts.env.PW_EVIDENCE_DIR, 'broken', 'failed')
        return fail()
      },
    })
    const { code, out } = run([], exec)
    expect(code).toBe(1)
    expect(out).toContain('marked ❌')
    expect(existsSync(join(root, 'frontend', 'pr-evidence', 'EVIDENCE.md'))).toBe(true)
  })

  it('fails clearly when nothing was recorded, or outside a repo', () => {
    expect(run([], fakeExec({ 'npx playwright': fail() }).exec).out).toContain('No evidence was recorded')
    expect(run([], fakeExec({ 'git rev-parse --show-toplevel': fail('not a repo') }).exec).out).toContain(
      'finding the repository failed: not a repo',
    )
    expect(run(['--bogus'], fakeExec().exec).code).toBe(1)
  })
})

describe('main: publish', () => {
  it('pushes the images and replaces only the evidence section of the PR body', () => {
    const { exec, calls } = fakeExec()
    const { code, out } = run(['--publish'], exec)
    expect(code).toBe(0)
    // The images were committed to the assets branch, hooks skipped.
    const push = calls.find((c) => c.cmd === 'git' && c.args.includes('push'))
    expect(push.args).toEqual(['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${ASSETS_BRANCH}`])
    // The PR body keeps the author's text and gets the new section with blob URLs.
    const edit = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'edit')
    expect(edit.args.slice(0, 3)).toEqual(['pr', 'edit', '7'])
    const body = readFileSync(edit.args[4], 'utf8')
    expect(body.startsWith('Intro\n')).toBe(true)
    expect(body).not.toContain('\nold\n')
    expect(body).toContain(
      'https://github.com/acme/listing-search/blob/pr-evidence/pr-7/abc1234/search-filters/01-final.png?raw=true',
    )
    expect(out).toContain('Evidence attached to https://github.com/acme/listing-search/pull/7')
  })

  it('asks for gh login when not authenticated', () => {
    const { out, code } = run(['--publish'], fakeExec({ 'gh auth status': fail('not logged in') }).exec)
    expect(code).toBe(1)
    expect(out).toContain('run `gh auth login`')
  })

  it('needs a PR unless --create is given', () => {
    const { out } = run(['--publish'], fakeExec({ 'gh pr view': fail('no pull requests found') }).exec)
    expect(out).toContain('npm run pr:create')
  })

  it('returns 1 after publishing evidence of failed tests', () => {
    const { exec } = fakeExec({
      'npx playwright': (_c, _a, opts) => {
        writeManifest(opts.env.PW_EVIDENCE_DIR, 'broken', 'failed')
        return fail()
      },
    })
    expect(run(['--publish'], exec).code).toBe(1)
  })
})

describe('findOrCreatePr', () => {
  it('creates a draft PR from the template with the last commit as title', () => {
    let created = false
    const { exec, calls } = fakeExec({
      'git log -1': ok('Add sorting\n'),
      'gh pr create': () => ((created = true), ok()),
      'gh pr view': () => (created ? ok(JSON.stringify({ number: 9, body: '', url: 'u' })) : fail()),
    })
    expect(findOrCreatePr(exec, root, true)).toEqual({ number: 9, body: '', url: 'u' })
    const create = calls.find((c) => c.args[1] === 'create')
    expect(create.args).toEqual([
      'pr',
      'create',
      '--draft',
      '--title',
      'Add sorting',
      '--body-file',
      join(root, '.github', 'pull_request_template.md'),
    ])
  })
})

describe('pushAssets', () => {
  it('starts an orphan branch with a README on first upload', () => {
    const { exec, calls } = fakeExec()
    const runDir = join(root, 'run')
    writeManifest(runDir, 't')
    pushAssets(exec, root, runDir, 'pr-1/abc', 'msg')
    const gitArgs = calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(0, 2).join(' '))
    expect(gitArgs).toContain('checkout --orphan')
    expect(gitArgs).toContain('rm -rf')
    expect(gitArgs.at(-1)).toBe('worktree remove') // always cleaned up
  })

  it('adds to the existing branch when it is already on the remote', () => {
    const { exec, calls } = fakeExec({ 'git ls-remote': ok('sha\trefs/heads/pr-evidence') })
    const runDir = join(root, 'run')
    writeManifest(runDir, 't')
    pushAssets(exec, root, runDir, 'pr-1/abc', 'msg')
    expect(calls.some((c) => c.args[0] === 'fetch')).toBe(true)
    expect(calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add').args.at(-1)).toBe('FETCH_HEAD')
    expect(calls.some((c) => c.args.includes('--orphan'))).toBe(false)
  })

  it('cleans up the worktree even when the push fails', () => {
    const { exec, calls } = fakeExec({ 'git push': fail('rejected') })
    const runDir = join(root, 'run')
    writeManifest(runDir, 't')
    expect(() => pushAssets(exec, root, runDir, 'pr-1/abc', 'msg')).toThrow('pushing evidence failed: rejected')
    expect(calls.at(-1).args.slice(0, 2)).toEqual(['worktree', 'remove'])
  })
})

describe('realExec', () => {
  it('runs a real command and captures its output and exit code', async () => {
    const { realExec } = await import('./cli.mjs')
    expect(realExec(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({
      code: 0,
      stdout: 'hi',
      stderr: '',
    })
    expect(realExec(process.execPath, ['-e', 'process.exit(3)']).code).toBe(3)
  })

  it('passes environment variables and working directory through', async () => {
    const { realExec } = await import('./cli.mjs')
    const res = realExec(process.execPath, ['-e', 'process.stdout.write(process.env.X + " " + process.cwd())'], {
      cwd: root,
      env: { X: 'y' },
    })
    expect(res.stdout).toContain('y ')
    expect(res.stdout).toContain(root.split('/').pop())
  })

  it('streams output when inherit is set', async () => {
    const { realExec } = await import('./cli.mjs')
    expect(realExec(process.execPath, ['-e', ''], { inherit: true })).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('reports a command that cannot start', async () => {
    const { realExec } = await import('./cli.mjs')
    const res = realExec('definitely-not-a-real-command-xyz', [])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('ENOENT')
  })
})

describe('edge cases', () => {
  it('reports a failure using stdout when stderr is empty', () => {
    const { out } = run(
      [],
      fakeExec({ 'git rev-parse --show-toplevel': { code: 1, stdout: 'from stdout', stderr: '' } }).exec,
    )
    expect(out).toContain('from stdout')
  })

  it('handles a PR with an empty description', () => {
    const { exec, calls } = fakeExec({ 'gh pr view': ok(JSON.stringify({ number: 3, body: null, url: 'u' })) })
    expect(run(['--publish'], exec).code).toBe(0)
    const edit = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'edit')
    expect(readFileSync(edit.args[4], 'utf8').startsWith(START_MARKER)).toBe(true)
  })

  it('returns an existing PR without creating one', () => {
    const { exec, calls } = fakeExec()
    expect(findOrCreatePr(exec, root, true).number).toBe(7)
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false)
  })
})
