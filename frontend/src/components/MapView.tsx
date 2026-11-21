/**
 * Results plotted on an OpenStreetMap map.
 *
 * @module
 */

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import type { ListingResult } from '../api'
import { usd } from '../lib/format'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import styles from './MapView.module.scss'

/** Props for {@link MapView}. */
interface Props {
  /** The listings on the current page. */
  results: ListingResult[]
  /** Called when a marker is clicked (opens the detail drawer). */
  onSelect: (listing: ListingResult) => void
}

/** OpenStreetMap's public tile server; its usage policy requires the attribution. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

/**
 * A Leaflet map with one marker per result, zoomed to fit them all.
 *
 * @remarks
 * Leaflet manages its own DOM, so React only renders the container `<div>`
 * and hands it to Leaflet in an effect:
 *
 * 1. The first effect creates the map once and destroys it on unmount (so
 *    switching back to the list view leaks nothing).
 * 2. The second effect redraws the markers whenever the results change,
 *    replacing the previous marker layer and re-fitting the view.
 *
 * Markers are `circleMarker`s (vector circles) rather than image pins, which
 * avoids Leaflet's well-known broken-icon problem with bundlers and lets
 * them use the theme's accent colour.
 *
 * The map is a visual extra: every listing it shows is also in the list
 * view, which is the accessible way to browse. Each marker is still reachable
 * by keyboard (Leaflet makes interactive markers focusable) and labelled.
 *
 * @param props - See {@link Props}.
 * @returns The map container.
 */
export function MapView({ results, onSelect }: Props) {
  const containerRef = useRef<HTMLElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  // Keep the latest onSelect without re-creating markers when it changes.
  // Updated in an effect (never during render), as React requires for refs.
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  // Effect 1: create the map once.
  useEffect(() => {
    const map = L.map(containerRef.current!, { scrollWheelZoom: false })
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map)
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  // Effect 2: (re)draw markers for the current results.
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    const points: L.LatLngExpression[] = []
    for (const r of results) {
      const point: L.LatLngExpression = [r.latitude, r.longitude]
      points.push(point)
      L.circleMarker(point, { radius: 9, weight: 2, color: '#fff', fillColor: '#6366f1', fillOpacity: 0.95 })
        .bindTooltip(`${r.address} · ${usd.format(r.price)}`)
        .on('click', () => onSelectRef.current(r))
        .addTo(layer)
    }

    // Fit all markers on screen; a single result gets a sensible street zoom.
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] })
    else if (points.length === 1) map.setView(points[0], 15)
    else map.setView([38.85, -77.25], 10) // Northern Virginia, where the sample data lives
  }, [results])

  return (
    <div className={cx(ui.card, styles.mapCard)}>
      <section ref={containerRef} className={styles.map} aria-label={`Map of ${results.length} listings`} />
    </div>
  )
}
