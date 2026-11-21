/**
 * Pure helpers for PR evidence: choosing which e2e specs to run, rendering a
 * DevTools-style network panel, and building the PR description section.
 *
 * @remarks
 * No I/O here (no files, no git, no network), so every rule is unit-tested in
 * `evidence.test.mjs`. The I/O lives in `cli.mjs` (the `npm run pr:evidence`
 * command) and in the e2e `evidence` fixture (`e2e/fixtures.ts`), which
 * records screenshots and API traffic while the specs run.
 *
 * @module
 */

/** Markers around the generated section in the PR description. Everything between them is replaced on each publish. */
export const START_MARKER = '<!-- pr-evidence:start -->'
export const END_MARKER = '<!-- pr-evidence:end -->'

/** Longest response body kept per request, so a big payload can't bloat the evidence. */
export const MAX_BODY_CHARS = 2000

/**
 * A short, file-system- and URL-safe name.
 *
 * @param {string} text - Any text, e.g. a test title.
 * @returns {string} Lowercase words joined by dashes, at most 80 characters.
 */
export function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  )
}

/**
 * Decide what the evidence run should cover, from the files this branch changed.
 *
 * @remarks
 * - Changed spec files (`frontend/e2e/*.spec.ts`) -> run every test in those
 *   files: the evidence shows the flows the PR actually adds or changes.
 * - No spec file changed -> run nothing (`skip`). Evidence of unchanged flows
 *   would only make the PR longer to review.
 * - `all` -> every spec, on request.
 *
 * @param {string[]} changedFiles - Repo-relative paths, e.g. `frontend/e2e/search.spec.ts`.
 * @param {{ all?: boolean }} [options]
 * @returns {{ specs: string[], skip: boolean, reason: string }} Spec paths
 *   relative to `frontend/` (empty = all when not skipping), whether to skip
 *   recording entirely, and why.
 */
export function pickSpecs(changedFiles, { all = false } = {}) {
  if (all) return { specs: [], skip: false, reason: 'all specs (--all)' }
  const specs = [
    ...new Set(changedFiles.map((f) => f.replace(/^frontend\//, '')).filter((f) => /^e2e\/.+\.spec\.ts$/.test(f))),
  ].sort()
  if (specs.length) return { specs, skip: false, reason: `changed specs: ${specs.join(', ')}` }
  return { specs: [], skip: true, reason: 'no e2e spec changed' }
}

/**
 * Shorten a response body for display.
 *
 * @param {unknown} body - Parsed JSON, a string, or nothing.
 * @returns {string} Pretty JSON (or the text), cut at {@link MAX_BODY_CHARS}.
 */
export function previewBody(body) {
  if (body === undefined || body === null || body === '') return ''
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n… (${text.length - MAX_BODY_CHARS} more characters)`
    : text
}

/**
 * Escape text for safe inclusion in HTML.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @typedef {object} NetworkEntry One API request seen during a test.
 * @property {string} method - e.g. `GET`.
 * @property {string} url - Path and query, e.g. `/api/v1/listings?city=Reston`.
 * @property {number} status - HTTP status (0 if it never got a response).
 * @property {number} durationMs - Time from request to response.
 * @property {string} [requestId] - The `X-Request-ID` response header.
 * @property {string} [contentType]
 * @property {unknown} [body] - Parsed JSON body, or text.
 * @property {string} [error] - Why it got no response, e.g. `net::ERR_ABORTED`.
 */

/**
 * `true` when the app itself cancelled the request (e.g. a newer search
 * replaced it). Shown grey as "(canceled)", like DevTools, not as a failure.
 *
 * @param {NetworkEntry} e
 * @returns {boolean}
 */
export const isCanceled = (e) => e.status === 0 && /ABORTED|cancel/i.test(e.error ?? '')

/**
 * The status as DevTools would show it.
 *
 * @param {NetworkEntry} e
 * @returns {string} e.g. `200`, `(canceled)`, `(failed)`.
 */
export const statusLabel = (e) => (e.status ? String(e.status) : isCanceled(e) ? '(canceled)' : '(failed)')

/**
 * Render a test's API traffic as a page that looks like the browser's
 * DevTools Network panel, ready to be screenshotted for the PR.
 *
 * @param {string} title - Test title, shown at the top.
 * @param {NetworkEntry[]} entries - Requests in the order they happened.
 * @returns {string} A complete HTML document.
 */
export function renderNetworkHtml(title, entries) {
  const rows = entries
    .map((e, i) => {
      const statusClass = isCanceled(e)
        ? 'muted'
        : e.status >= 400 || e.status === 0
          ? 'err'
          : e.status >= 300
            ? 'warn'
            : 'ok'
      const name = e.url.replace(/^\/api\/v\d+\//, '')
      return `<tr class="${i % 2 ? 'alt' : ''}">
  <td class="name" title="${escapeHtml(e.url)}">${escapeHtml(name)}</td>
  <td>${escapeHtml(e.method)}</td>
  <td class="${statusClass}">${statusLabel(e)}</td>
  <td>${escapeHtml((e.contentType ?? '').split(';')[0] || '-')}</td>
  <td class="mono">${escapeHtml(e.requestId ?? '-')}</td>
  <td class="num">${Math.round(e.durationMs)} ms</td>
</tr>
<tr class="preview"><td colspan="6"><pre>${escapeHtml(previewBody(e.body)) || `<span class="muted">${isCanceled(e) ? 'Canceled by the app (a newer request replaced it)' : escapeHtml(e.error ?? '(no body)')}</span>`}</pre></td></tr>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Network - ${escapeHtml(title)}</title>
<style>
  body { margin: 0; font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; background: #fff; color: #1f1f1f; }
  header { padding: 8px 12px; background: #f1f3f4; border-bottom: 1px solid #cbcdd1; display: flex; gap: 16px; align-items: center; }
  header b { font-size: 12px; } header span { color: #5f6368; }
  .tabs { display: flex; gap: 14px; padding: 0 12px; border-bottom: 1px solid #cbcdd1; background: #f1f3f4; }
  .tabs span { padding: 6px 0; color: #5f6368; } .tabs .on { color: #1a73e8; border-bottom: 2px solid #1a73e8; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; color: #5f6368; background: #f8f9fa; border-bottom: 1px solid #cbcdd1; padding: 4px 8px; }
  td { padding: 4px 8px; border-bottom: 1px solid #ececec; white-space: nowrap; }
  tr.alt td { background: #f8f9fa; }
  .name { max-width: 460px; overflow: hidden; text-overflow: ellipsis; color: #1f1f1f; }
  .ok { color: #188038; } .warn { color: #b06000; } .err { color: #d93025; font-weight: 600; }
  .num { text-align: right; } .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #5f6368; }
  tr.preview td { background: #fcfcfd; border-bottom: 1px solid #cbcdd1; white-space: normal; }
  pre { margin: 0; max-height: 220px; overflow: hidden; font: 11px/1.45 ui-monospace, Menlo, monospace; color: #3c4043; white-space: pre-wrap; }
  .muted { color: #9aa0a6; } footer { padding: 6px 12px; color: #5f6368; border-top: 1px solid #cbcdd1; background: #f1f3f4; }
</style></head><body>
<header><b>Network</b><span>${escapeHtml(title)}</span><span>Filter: /api/</span></header>
<div class="tabs"><span class="on">Fetch/XHR</span><span>Headers</span><span>Preview</span><span>Response</span></div>
<table><thead><tr><th>Name</th><th>Method</th><th>Status</th><th>Type</th><th>X-Request-ID</th><th class="num">Time</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6" class="muted">No API requests were made in this test.</td></tr>'}
</tbody></table>
<footer>${entries.length} request${entries.length === 1 ? '' : 's'}</footer>
</body></html>`
}

/**
 * @typedef {object} EvidenceTest One test's evidence, as written by the e2e fixture.
 * @property {string} title - Full test title, e.g. "search › filters by city".
 * @property {string} file - Spec file, e.g. `e2e/search.spec.ts`.
 * @property {'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'} status
 * @property {string} dir - Folder of this test's files, relative to the run folder.
 * @property {{ label: string, file: string }[]} screenshots - In capture order.
 * @property {string} networkImage - The rendered network panel, relative to `dir`.
 * @property {NetworkEntry[]} network
 */

const STATUS_ICON = { passed: '✅', failed: '❌', timedOut: '⏱️', skipped: '⏭️', interrupted: '⚠️' }

/**
 * Build the Markdown section that goes into the PR description.
 *
 * @param {object} input
 * @param {EvidenceTest[]} input.tests
 * @param {(path: string) => string} input.imageUrl - Maps a run-relative path to a URL the PR can load.
 * @param {string} input.reason - What was run and why (from {@link pickSpecs}).
 * @param {string} input.commit - Short SHA the evidence was recorded at.
 * @returns {string} Markdown wrapped in the start/end markers.
 */
export function buildEvidenceMarkdown({ tests, imageUrl, reason, commit }) {
  const passed = tests.filter((t) => t.status === 'passed').length
  const lines = [
    START_MARKER,
    `#### E2E evidence · \`${commit}\``,
    '',
    `Recorded by \`npm run pr:evidence\` from ${reason}. **${passed}/${tests.length} passed.** Each test shows its screenshots and the API calls it made, as a network-panel view plus the raw responses.`,
    '',
  ]
  if (!tests.length) lines.push('_No tests ran._', '')
  for (const t of tests) {
    const icon = STATUS_ICON[t.status] ?? '•'
    lines.push(
      `<details${t.status === 'passed' ? '' : ' open'}><summary>${icon} <b>${escapeHtml(t.title)}</b> <code>${escapeHtml(t.file)}</code></summary>`,
      '',
    )
    for (const s of t.screenshots) {
      lines.push(
        `**${escapeHtml(s.label)}**`,
        '',
        `<img src="${imageUrl(`${t.dir}/${s.file}`)}" alt="${escapeHtml(`${t.title}: ${s.label}`)}" width="720">`,
        '',
      )
    }
    lines.push(
      `**Network (Fetch/XHR)**`,
      '',
      `<img src="${imageUrl(`${t.dir}/${t.networkImage}`)}" alt="${escapeHtml(`${t.title}: network requests`)}" width="720">`,
      '',
    )
    if (t.network.length) {
      lines.push('| Method | Request | Status | Time | X-Request-ID |', '| --- | --- | --- | --- | --- |')
      for (const e of t.network) {
        lines.push(
          `| ${e.method} | \`${e.url.replace(/\|/g, '\\|')}\` | ${statusLabel(e)} | ${Math.round(e.durationMs)} ms | \`${e.requestId ?? '-'}\` |`,
        )
      }
      lines.push('')
    }
    lines.push('</details>', '')
  }
  lines.push(END_MARKER)
  return lines.join('\n')
}

/**
 * Put the evidence section into a PR description, replacing any earlier one.
 *
 * @remarks
 * Only the text between the markers changes, so everything the author wrote
 * is kept. If there are no markers yet (e.g. the template section was
 * deleted), the section is appended at the end.
 *
 * @param {string} body - The current PR description.
 * @param {string} section - Output of {@link buildEvidenceMarkdown}.
 * @returns {string} The new description.
 */
export function replaceEvidenceBlock(body, section) {
  const start = body.indexOf(START_MARKER)
  const end = body.indexOf(END_MARKER)
  if (start !== -1 && end > start) return body.slice(0, start) + section + body.slice(end + END_MARKER.length)
  if (!body.trim()) return `${section}\n`
  return `${body.trimEnd()}\n\n${section}\n`
}
