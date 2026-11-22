import { describe, expect, it } from 'vitest'
import { LAST_STOP, PRICE_STOPS, amountOf, cleanPrice, formatPrice, stopFor } from './price'

describe('cleanPrice', () => {
  it.each([
    ['$650,000', '650000'],
    [' 1 200 000 ', '1200000'],
    ['650000', '650000'],
    ['', ''],
  ])('turns %j into %j', (typed, clean) => {
    expect(cleanPrice(typed)).toBe(clean)
  })

  it('leaves anything else for the API to reject', () => {
    expect(cleanPrice('-5')).toBe('-5')
    expect(cleanPrice('650k')).toBe('650k')
  })
})

describe('formatPrice', () => {
  it('adds thousands separators to whole numbers', () => {
    expect(formatPrice('650000')).toBe('650,000')
    expect(formatPrice('1200000')).toBe('1,200,000')
    expect(formatPrice('0')).toBe('0')
  })

  it('returns other text unchanged', () => {
    expect(formatPrice('')).toBe('')
    expect(formatPrice('-5')).toBe('-5')
    expect(formatPrice('12.5')).toBe('12.5')
  })
})

describe('PRICE_STOPS', () => {
  it('runs from $0 to $50,000,000 in steps that grow with the price', () => {
    expect(PRICE_STOPS[0]).toBe(0)
    expect(PRICE_STOPS[LAST_STOP]).toBe(50_000_000)
    const stepAt = (price: number) => PRICE_STOPS[PRICE_STOPS.indexOf(price) + 1] - price
    expect(stepAt(500_000)).toBe(25_000)
    expect(stepAt(1_500_000)).toBe(50_000)
    expect(stepAt(3_000_000)).toBe(100_000)
    expect(stepAt(7_000_000)).toBe(250_000)
    expect(stepAt(15_000_000)).toBe(500_000)
    expect(stepAt(30_000_000)).toBe(1_000_000)
  })

  it('gives ordinary prices a good share of the slider', () => {
    // Under $1M, where most homes sell, gets about a quarter of the track.
    expect(PRICE_STOPS.indexOf(1_000_000) / LAST_STOP).toBeGreaterThan(0.2)
  })
})

describe('stopFor', () => {
  it('finds the stop at or below an amount', () => {
    expect(PRICE_STOPS[stopFor('450000', 0)]).toBe(450_000)
    expect(PRICE_STOPS[stopFor('470000', 0)]).toBe(450_000)
    expect(stopFor('90000000', 0)).toBe(LAST_STOP)
    expect(PRICE_STOPS[stopFor('500000.50', 0)]).toBe(500_000)
  })

  it('uses the given stop for blank or unreadable values', () => {
    expect(stopFor('', 7)).toBe(7)
    expect(stopFor('-5', LAST_STOP)).toBe(LAST_STOP)
  })
})

describe('amountOf', () => {
  it('reads whole and decimal amounts', () => {
    expect(amountOf('470000')).toBe(470_000)
    expect(amountOf('500000.50')).toBe(500_000.5)
    expect(amountOf('0')).toBe(0)
  })

  it('returns undefined for blank, negative or unreadable text', () => {
    for (const raw of ['', ' ', '-5', 'abc', 'Infinity']) expect(amountOf(raw)).toBeUndefined()
  })
})
