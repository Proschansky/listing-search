/**
 * Component tests for {@link MapView}, with Leaflet mocked.
 *
 * @remarks
 * jsdom has no layout engine, so a real Leaflet map can't measure itself or
 * load tiles. The mock records what the component asks Leaflet to do (create
 * a map, add markers, fit bounds, clean up), which is exactly the
 * component's responsibility. Leaflet's own rendering is Leaflet's to test;
 * the Playwright e2e suite covers the real thing in a browser.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listing, listing2 } from '../test/fixtures'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'

// vi.mock is hoisted above the imports, so the fakes it uses are hoisted too.
const leaflet = vi.hoisted(() => {
  const markers: { latlng: unknown; tooltip?: string; click?: () => void }[] = []
  const map = { fitBounds: vi.fn(), setView: vi.fn(), remove: vi.fn() }
  const layer = { clearLayers: vi.fn(() => (markers.length = 0)), addTo: vi.fn() }
  layer.addTo.mockReturnValue(layer)
  const circleMarker = vi.fn((latlng: unknown) => {
    const m: (typeof markers)[number] = { latlng }
    const api = {
      bindTooltip: (t: string) => ((m.tooltip = t), api),
      on: (_e: string, fn: () => void) => ((m.click = fn), api),
      addTo: () => (markers.push(m), api),
    }
    return api
  })
  return {
    markers,
    map,
    layer,
    circleMarker,
    L: {
      map: vi.fn(() => map),
      tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
      layerGroup: vi.fn(() => layer),
      circleMarker,
      latLngBounds: vi.fn((pts: unknown) => ({ pts })),
    },
  }
})
vi.mock('leaflet', () => ({ default: leaflet.L }))
vi.mock('leaflet/dist/leaflet.css', () => ({}))

import { MapView } from './MapView'

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('MapView', () => {
  it('creates one map with OpenStreetMap tiles and the required attribution', () => {
    render(<MapView results={[listing]} onSelect={() => {}} />)
    expect(leaflet.L.map).toHaveBeenCalledOnce()
    const [url, opts] = leaflet.L.tileLayer.mock.calls[0] as unknown as [string, { attribution: string }]
    expect(url).toContain('tile.openstreetmap.org')
    expect(opts.attribution).toContain('OpenStreetMap')
  })

  it('adds a labelled marker per listing at its coordinates', () => {
    render(<MapView results={[listing, listing2]} onSelect={() => {}} />)
    expect(leaflet.markers.map((m) => m.latlng)).toEqual([
      [listing.latitude, listing.longitude],
      [listing2.latitude, listing2.longitude],
    ])
    expect(leaflet.markers[0].tooltip).toBe('55 Elm Ct · $470,000')
  })

  it('fits several markers in view, and zooms to a single one', () => {
    const { rerender } = render(<MapView results={[listing, listing2]} onSelect={() => {}} />)
    expect(leaflet.map.fitBounds).toHaveBeenCalledOnce()
    rerender(<MapView results={[listing]} onSelect={() => {}} />)
    expect(leaflet.map.setView).toHaveBeenCalledWith([listing.latitude, listing.longitude], 15)
  })

  it('falls back to a default view with no results', () => {
    render(<MapView results={[]} onSelect={() => {}} />)
    expect(leaflet.map.setView).toHaveBeenCalledWith([38.85, -77.25], 10)
  })

  it('redraws markers when the results change', () => {
    const { rerender } = render(<MapView results={[listing, listing2]} onSelect={() => {}} />)
    rerender(<MapView results={[listing2]} onSelect={() => {}} />)
    expect(leaflet.layer.clearLayers).toHaveBeenCalledTimes(2)
    expect(leaflet.markers).toHaveLength(1)
  })

  it('calls the latest onSelect when a marker is clicked', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = render(<MapView results={[listing]} onSelect={first} />)
    rerender(<MapView results={[listing]} onSelect={latest} />)
    leaflet.markers[0].click!()
    expect(latest).toHaveBeenCalledWith(listing)
    expect(first).not.toHaveBeenCalled()
  })

  it('destroys the map on unmount', () => {
    const { unmount } = render(<MapView results={[listing]} onSelect={() => {}} />)
    unmount()
    expect(leaflet.map.remove).toHaveBeenCalledOnce()
  })

  it('labels the map region with the number of listings', () => {
    render(<MapView results={[listing, listing2]} onSelect={() => {}} />)
    expect(screen.getByRole('region', { name: 'Map of 2 listings' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<MapView results={[listing]} onSelect={() => {}} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
