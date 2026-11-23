import { describe, expect, it } from 'vitest'
import {
  LAST_STOP,
  NO_MAX,
  NO_MIN,
  PRICE_STOPS,
  amountOf,
  cleanPrice,
  formatPrice,
  moveHandle,
  rangePosition,
  stopFor,
} from './price'

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

  it('reads the other forms the API accepts', () => {
    expect(amountOf('1_000_000')).toBe(1_000_000)
    expect(amountOf('1e6')).toBe(1_000_000)
    expect(amountOf('.5')).toBe(0.5)
    expect(amountOf('5.')).toBe(5)
    expect(amountOf('+5')).toBe(5)
    expect(amountOf(' 5 ')).toBe(5)
  })

  it('reads digits from other scripts, as Python does', () => {
    expect(amountOf('٥٠٠٠٠٠')).toBe(500_000) // Arabic-Indic
    expect(amountOf('५००००')).toBe(50_000) // Devanagari
    expect(amountOf('𝟓𝟎𝟎')).toBe(500) // mathematical bold digits, several runs of ten in a row
  })

  it('reads -0 as $0, checking the sign after conversion', () => {
    expect(amountOf('-0')).toBe(0)
    expect(Object.is(amountOf('-0'), 0)).toBe(true)
    expect(amountOf('-0.0')).toBe(0)
  })

  it('returns undefined for anything the API rejects or that is negative', () => {
    for (const raw of ['', ' ', '-5', 'abc', 'Infinity', 'nan', '0x10', '1__0', '_1', '1_', '1e', '.', '1e999'])
      expect(amountOf(raw), raw).toBeUndefined()
  })
})

describe('moveHandle', () => {
  const at = (price: number) => PRICE_STOPS.indexOf(price) + 1 // range position

  describe('keyboard (no anchor)', () => {
    it('moves one end and keeps the other', () => {
      expect(moveHandle('low', at(450_000), { min: '400000', max: '600000' })).toEqual({ min: '450000', max: '600000' })
      expect(moveHandle('high', at(550_000), { min: '400000', max: '600000' })).toEqual({
        min: '400000',
        max: '550000',
      })
    })

    it('clears an end moved all the way out', () => {
      expect(moveHandle('low', NO_MIN, { min: '400000', max: '600000' })).toEqual({ min: '', max: '600000' })
      expect(moveHandle('high', NO_MAX, { min: '400000', max: '600000' })).toEqual({ min: '400000', max: '' })
    })

    it('stops at the exact amount at the other end', () => {
      expect(moveHandle('high', at(450_000), { min: '470000', max: '500000' })).toEqual({
        min: '470000',
        max: '470000',
      })
      expect(moveHandle('low', at(600_000), { min: '', max: '500000.50' })).toEqual({
        min: '500000.5',
        max: '500000.50',
      })
    })

    it('stops at the minimum instead of clearing the maximum near the top', () => {
      // A $60M max sits on the last stop. One step left asks for $49M, below
      // the $50M min: the max stops at $50M rather than becoming "no max".
      expect(moveHandle('high', at(49_000_000), { min: '50000000', max: '60000000' })).toEqual({
        min: '50000000',
        max: '50000000',
      })
    })

    it('treats a blank or unreadable other end as no limit', () => {
      expect(moveHandle('low', at(600_000), { min: '', max: '' })).toEqual({ min: '600000', max: '' })
      expect(moveHandle('high', at(100_000), { min: 'abc', max: '' })).toEqual({ min: 'abc', max: '100000' })
    })
  })

  describe('pointer drag (with an anchor)', () => {
    const range = { min: '500000', max: '500000' }

    it('pulls apart two handles on the same spot in either direction', () => {
      // Only the top (high) handle can be grabbed. Dragging it left makes
      // it the new minimum; dragging it right raises the maximum.
      expect(moveHandle('high', at(400_000), range, '500000')).toEqual({ min: '400000', max: '500000' })
      expect(moveHandle('high', at(600_000), range, '500000')).toEqual({ min: '500000', max: '600000' })
    })

    it('swaps the ends when the low handle passes the high one', () => {
      expect(moveHandle('low', at(700_000), range, '500000')).toEqual({ min: '500000', max: '700000' })
      expect(moveHandle('low', NO_MAX, range, '500000')).toEqual({ min: '500000', max: '' })
    })

    it('swaps the ends when the high handle passes the low one', () => {
      expect(moveHandle('high', NO_MIN, range, '500000')).toEqual({ min: '', max: '500000' })
    })

    it('treats a blank anchor as the open end, which can not be passed', () => {
      expect(moveHandle('low', NO_MAX, { min: '', max: '' }, '')).toEqual({ min: '50000000', max: '' })
      expect(moveHandle('high', NO_MIN, { min: '', max: '' }, '')).toEqual({ min: '', max: '0' })
    })
  })
})

describe('rangePosition', () => {
  it('keeps the ends for "no limit"', () => {
    expect(rangePosition('', 'min')).toBe(NO_MIN)
    expect(rangePosition('', 'max')).toBe(NO_MAX)
    expect(rangePosition('abc', 'max')).toBe(NO_MAX)
  })

  it('puts typed amounts on the stops between the ends, never on them', () => {
    expect(rangePosition('0', 'min')).toBe(NO_MIN + 1)
    expect(rangePosition('500000', 'max')).toBe(PRICE_STOPS.indexOf(500_000) + 1)
    expect(rangePosition('60000000', 'max')).toBe(NO_MAX - 1)
  })
})
