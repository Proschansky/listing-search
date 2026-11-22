/**
 * Accessibility assertions powered by axe-core (free, open-source, by Deque).
 *
 * @remarks
 * Runs the WCAG 2.0/2.1/2.2 A and AA rule sets plus axe's best-practice
 * rules against rendered DOM. `color-contrast` is switched off because jsdom
 * has no layout or computed colours, so axe can't measure contrast there;
 * contrast is a property of the CSS palette, checked in a real browser.
 *
 * @module
 */

import axe, { type AxeResults, type Result } from 'axe-core'
import { expect } from 'vitest'

/**
 * Format violations so a failing test says exactly what is wrong and where.
 *
 * @param violations - axe violations.
 * @returns One block per rule, listing the offending elements.
 */
function describeViolations(violations: Result[]): string {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n  ${v.helpUrl}\n${v.nodes.map((n) => `  - ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n\n')
}

/**
 * Run axe on an element and return the raw results.
 *
 * @param root - Element to audit. Defaults to the whole document.
 * @returns axe's results.
 */
export function runAxe(root: Element | Document = document): Promise<AxeResults> {
  return axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false } },
  })
}

/**
 * Assert that an element has no accessibility violations.
 *
 * @param root - Element to audit. Defaults to the whole document.
 * @param options - Rules to skip for this check, such as landmark rules when
 *   auditing a component on its own, outside the page's landmarks.
 */
export async function expectNoA11yViolations(
  root: Element | Document = document,
  options: { skip?: string[] } = {},
): Promise<void> {
  const results = await runAxe(root)
  const violations = results.violations.filter((v) => !options.skip?.includes(v.id))
  expect(violations, describeViolations(violations)).toEqual([])
}

/**
 * Landmark rules that only make sense for a whole page, not a component
 * rendered alone in a test.
 */
export const COMPONENT_ONLY_SKIP = ['region', 'landmark-one-main', 'page-has-heading-one', 'heading-order']
