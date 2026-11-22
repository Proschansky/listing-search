/**
 * Unit tests for the pure PR-evidence helpers.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  buildEvidenceMarkdown,
  END_MARKER,
  escapeHtml,
  MAP_TILES_NOTE,
  MAX_BODY_CHARS,
  pickSpecs,
  previewBody,
  renderNetworkHtml,
  replaceEvidenceBlock,
  slug,
  START_MARKER,
} from './evidence.mjs'

describe('slug', () => {
  it('makes a short, safe name', () => {
    expect(slug('search › Filters by City & Keyword!')).toBe('search-filters-by-city-keyword')
    expect(slug('x'.repeat(200))).toHaveLength(80)
    expect(slug('!!!')).toBe('untitled')
  })
})

describe('pickSpecs', () => {
  it('runs exactly the specs the branch changed', () => {
    const files = [
      'frontend/e2e/search.spec.ts',
      'frontend/src/App.tsx',
      'frontend/e2e/details.spec.ts',
      'frontend/e2e/search.spec.ts',
    ]
    expect(pickSpecs(files)).toEqual({
      specs: ['e2e/details.spec.ts', 'e2e/search.spec.ts'],
      skip: false,
      reason: 'changed specs: e2e/details.spec.ts, e2e/search.spec.ts',
    })
  })

  it('skips recording entirely when no spec file changed', () => {
    // UI code, the fixtures file and backend changes alone record nothing.
    expect(pickSpecs(['frontend/src/App.tsx', 'frontend/e2e/fixtures.ts', 'backend/app/main.py'])).toEqual({
      specs: [],
      skip: true,
      reason: 'no e2e spec changed',
    })
    expect(pickSpecs([])).toMatchObject({ skip: true })
  })

  it('runs everything with all, even when nothing changed', () => {
    expect(pickSpecs([], { all: true })).toEqual({ specs: [], skip: false, reason: 'all specs (--all)' })
  })
})

describe('previewBody', () => {
  it('pretty-prints JSON, keeps text, and is empty for no body', () => {
    expect(previewBody({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(previewBody('plain')).toBe('plain')
    expect(previewBody(undefined)).toBe('')
    expect(previewBody(null)).toBe('')
    expect(previewBody('')).toBe('')
  })

  it('truncates long bodies and says how much was cut', () => {
    const out = previewBody('x'.repeat(MAX_BODY_CHARS + 50))
    expect(out.startsWith('x'.repeat(MAX_BODY_CHARS))).toBe(true)
    expect(out).toContain('(50 more characters)')
  })
})

describe('escapeHtml', () => {
  it('escapes markup characters and tolerates nullish values', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
    expect(escapeHtml(undefined)).toBe('')
  })
})

const entry = (overrides = {}) => ({
  method: 'GET',
  url: '/api/v1/listings?city=Reston',
  status: 200,
  durationMs: 12.6,
  requestId: 'abc123',
  contentType: 'application/json; charset=utf-8',
  body: { results: [] },
  ...overrides,
})

describe('renderNetworkHtml', () => {
  it('lists each request like a network panel, with its response preview', () => {
    const html = renderNetworkHtml('search › <test>', [
      entry(),
      entry({ status: 400, url: '/api/v1/listings?minPrice=-1' }),
    ])
    expect(html).toContain('<td class="name" title="/api/v1/listings?city=Reston">listings?city=Reston</td>')
    expect(html).toContain('<td class="ok">200</td>')
    expect(html).toContain('<td class="err">400</td>')
    expect(html).toContain('application/json<')
    expect(html).toContain('13 ms')
    expect(html).toContain('&quot;results&quot;')
    expect(html).toContain('search › &lt;test&gt;')
    expect(html).toContain('2 requests')
  })

  it('marks redirects, failures and missing fields', () => {
    const html = renderNetworkHtml('t', [
      entry({ status: 302 }),
      entry({ status: 0, requestId: undefined, contentType: undefined, body: undefined }),
    ])
    expect(html).toContain('<td class="warn">302</td>')
    expect(html).toContain('<td class="err">(failed)</td>')
    expect(html).toContain('(no body)')
    expect(html).toContain('2 requests')
  })

  it('says when a test made no API calls', () => {
    const html = renderNetworkHtml('t', [])
    expect(html).toContain('No API requests were made in this test.')
    expect(html).toContain('0 requests')
  })

  it('shows requests the app cancelled as grey "(canceled)", not failures', () => {
    const html = renderNetworkHtml('t', [
      entry({ status: 0, error: 'net::ERR_ABORTED', body: undefined }),
      entry({ status: 0, error: 'net::ERR_CONNECTION_REFUSED', body: undefined }),
    ])
    expect(html).toContain('<td class="muted">(canceled)</td>')
    expect(html).toContain('Canceled by the app')
    expect(html).toContain('<td class="err">(failed)</td>')
    expect(html).toContain('net::ERR_CONNECTION_REFUSED')
  })

  it('uses the singular for one request', () => {
    expect(renderNetworkHtml('t', [entry()])).toContain('1 request<')
  })
})

const test = (overrides = {}) => ({
  title: 'search › filters',
  file: 'e2e/search.spec.ts',
  status: 'passed',
  dir: 'search-filters',
  screenshots: [{ label: 'Filtered', file: '01-filtered.png' }],
  networkImage: 'network.png',
  network: [entry({ url: '/api/v1/listings?q=a|b' })],
  ...overrides,
})

describe('buildEvidenceMarkdown', () => {
  const imageUrl = (p) => `https://img/${p}`

  it('adds the map note above the first test when any test had its map tiles blocked', () => {
    const md = buildEvidenceMarkdown({
      tests: [test(), test({ title: 'map view', mapTilesBlocked: true })],
      imageUrl,
      reason: 'r',
      commit: 'c',
    })
    expect(md).toContain(MAP_TILES_NOTE)
    expect(MAP_TILES_NOTE.startsWith('> [!NOTE]\n> Map screenshots show markers on a blank background')).toBe(true)
    // Above the accordion: before the first <details>.
    expect(md.indexOf(MAP_TILES_NOTE)).toBeLessThan(md.indexOf('<details'))
    expect(md.split(MAP_TILES_NOTE)).toHaveLength(2) // once, not per test
  })

  it('leaves the map note out when no test touched the map', () => {
    const md = buildEvidenceMarkdown({
      tests: [test(), test({ mapTilesBlocked: false })],
      imageUrl,
      reason: 'r',
      commit: 'c',
    })
    expect(md).not.toContain('[!NOTE]')
  })

  it('wraps a per-test section in the markers', () => {
    const md = buildEvidenceMarkdown({ tests: [test()], imageUrl, reason: 'changed specs: x', commit: 'abc1234' })
    expect(md.startsWith(START_MARKER)).toBe(true)
    expect(md.endsWith(END_MARKER)).toBe(true)
    expect(md).toContain('#### E2E evidence · `abc1234`')
    expect(md).toContain('from changed specs: x. **1/1 passed.**')
    expect(md).toContain('<details><summary>✅ <b>search › filters</b> <code>e2e/search.spec.ts</code></summary>')
    expect(md).toContain(
      '<img src="https://img/search-filters/01-filtered.png" alt="search › filters: Filtered" width="720">',
    )
    expect(md).toContain('<img src="https://img/search-filters/network.png"')
    // Pipes in URLs are escaped so they don't break the table.
    expect(md).toContain('| GET | `/api/v1/listings?q=a\\|b` | 200 | 13 ms | `abc123` |')
  })

  it('opens failed tests by default and marks them', () => {
    const md = buildEvidenceMarkdown({
      tests: [test({ status: 'failed' }), test({ status: 'weird' })],
      imageUrl,
      reason: 'r',
      commit: 'c',
    })
    expect(md).toContain('<details open><summary>❌')
    expect(md).toContain('<details open><summary>•')
    expect(md).toContain('**0/2 passed.**')
  })

  it('omits the request table for tests with no API calls, and handles no tests', () => {
    expect(buildEvidenceMarkdown({ tests: [test({ network: [] })], imageUrl, reason: 'r', commit: 'c' })).not.toContain(
      '| Method |',
    )
    expect(buildEvidenceMarkdown({ tests: [], imageUrl, reason: 'r', commit: 'c' })).toContain('_No tests ran._')
  })

  it('shows failed requests and missing request IDs', () => {
    const md = buildEvidenceMarkdown({
      tests: [test({ network: [entry({ status: 0, requestId: undefined })] })],
      imageUrl,
      reason: 'r',
      commit: 'c',
    })
    expect(md).toContain('| (failed) | 13 ms | `-` |')
  })
})

describe('replaceEvidenceBlock', () => {
  const section = `${START_MARKER}\nnew\n${END_MARKER}`

  it('replaces only the text between the markers', () => {
    const body = `## TL;DR\nkeep\n${START_MARKER}\nold\n${END_MARKER}\nafter`
    expect(replaceEvidenceBlock(body, section)).toBe(`## TL;DR\nkeep\n${section}\nafter`)
  })

  it('uses the section alone for an empty description', () => {
    expect(replaceEvidenceBlock('  \n', section)).toBe(`${section}\n`)
  })

  it('appends when the markers are missing or out of order', () => {
    expect(replaceEvidenceBlock('body\n\n', section)).toBe(`body\n\n${section}\n`)
    expect(replaceEvidenceBlock(`${END_MARKER} x ${START_MARKER}`, section)).toBe(
      `${END_MARKER} x ${START_MARKER}\n\n${section}\n`,
    )
  })
})
