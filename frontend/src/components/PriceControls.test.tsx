import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAST_STOP, PRICE_STOPS } from '../lib/price'
import { PriceInput, PriceRangeSlider, PriceSlider } from './PriceControls'

/** The slider position (stop index) for a dollar amount on the scale. */
const at = (price: number) => String(PRICE_STOPS.indexOf(price))

afterEach(cleanup)

/** A PriceInput with real state, so typing behaves as it does in the app. */
function Box({ initial = '', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <PriceInput
      aria-label="Price"
      value={value}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
    />
  )
}

describe('PriceInput', () => {
  it('is a plain text box with a numeric keypad, not a number spinner', () => {
    render(<Box />)
    const box = screen.getByLabelText('Price')
    expect(box).toHaveAttribute('type', 'text')
    expect(box).toHaveAttribute('inputmode', 'numeric')
  })

  it('shows commas when not focused and the plain digits while editing', async () => {
    const onValue = vi.fn()
    render(<Box initial="650000" onValue={onValue} />)
    const box = screen.getByLabelText('Price')
    expect(box).toHaveValue('650,000')
    await userEvent.click(box)
    expect(box).toHaveValue('650000')
    await userEvent.clear(box)
    await userEvent.type(box, '$1,200,000')
    expect(onValue).toHaveBeenLastCalledWith('1200000')
    await userEvent.tab()
    expect(box).toHaveValue('1,200,000')
  })

  it('keeps text it cannot read so the API error makes sense', async () => {
    render(<Box initial="-5" />)
    expect(screen.getByLabelText('Price')).toHaveValue('-5')
  })

  it('still calls focus and blur handlers it was given', async () => {
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(<PriceInput aria-label="P" value="" onChange={() => {}} onFocus={onFocus} onBlur={onBlur} />)
    await userEvent.click(screen.getByLabelText('P'))
    await userEvent.tab()
    expect(onFocus).toHaveBeenCalledOnce()
    expect(onBlur).toHaveBeenCalledOnce()
  })
})

describe('PriceSlider', () => {
  it('shows the amount as its position and reads it out in dollars', () => {
    render(<PriceSlider label="Budget" blankText="No target" value="470000" onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: 'Budget' })
    expect(slider).toHaveAttribute('max', String(LAST_STOP))
    // $470,000 isn't a stop; the handle sits on the one below, $450,000.
    expect(slider).toHaveValue(at(450_000))
    expect(slider).toHaveAttribute('aria-valuetext', '$470,000')
  })

  it('reports the dollar amount of the stop it moves to, and blank at the far left', () => {
    const onChange = vi.fn()
    render(<PriceSlider label="Budget" blankText="No target" value="500000" onChange={onChange} />)
    const slider = screen.getByRole('slider', { name: 'Budget' })
    fireEvent.change(slider, { target: { value: at(12_000_000) } })
    expect(onChange).toHaveBeenLastCalledWith('12000000')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('reads out a decimal amount instead of calling it unset', () => {
    render(<PriceSlider label="Budget" blankText="No target" value="500000.50" onChange={() => {}} />)
    expect(screen.getByRole('slider', { name: 'Budget' })).toHaveAttribute('aria-valuetext', '$500,000.50')
  })

  it('says when no amount is set', () => {
    render(<PriceSlider label="Budget" blankText="No target" value="" onChange={() => {}} />)
    expect(screen.getByRole('slider', { name: 'Budget' })).toHaveAttribute('aria-valuetext', 'No target')
  })

  it('pins to the end for amounts above its range', () => {
    render(<PriceSlider label="Budget" blankText="No target" value="75000000" onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: 'Budget' })
    expect(slider).toHaveValue(String(LAST_STOP))
    expect(slider).toHaveAttribute('aria-valuetext', '$75,000,000')
  })
})

describe('PriceRangeSlider', () => {
  const setup = (min = '', max = '') => {
    const onChange = vi.fn()
    render(<PriceRangeSlider min={min} max={max} onChange={onChange} />)
    return {
      onChange,
      low: screen.getByRole('slider', { name: 'Lowest price' }),
      high: screen.getByRole('slider', { name: 'Highest price' }),
    }
  }

  it('starts at both ends when no range is set', () => {
    const { low, high } = setup()
    expect(low).toHaveValue('0')
    expect(high).toHaveValue(String(LAST_STOP))
    expect(low).toHaveAttribute('aria-valuetext', 'No min')
    expect(high).toHaveAttribute('aria-valuetext', 'No max')
  })

  it('updates one end and keeps the other', () => {
    const { onChange, low, high } = setup('400000', '3000000')
    fireEvent.change(low, { target: { value: at(450_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '450000', max: '3000000' })
    fireEvent.change(high, { target: { value: at(2_500_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '400000', max: '2500000' })
  })

  it('clears an end dragged all the way out', () => {
    const { onChange, low, high } = setup('400000', '600000')
    fireEvent.change(low, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '', max: '600000' })
    fireEvent.change(high, { target: { value: String(LAST_STOP) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '400000', max: '' })
  })

  it('stops a handle at the other one', () => {
    const { onChange, low, high } = setup('400000', '600000')
    fireEvent.change(low, { target: { value: at(800_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '600000', max: '600000' })
    fireEvent.change(high, { target: { value: at(100_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '400000', max: '400000' })
  })

  it('puts the low handle on top past the middle, so it can still be dragged when both meet at the end', () => {
    const { low } = setup('40000000', '')
    expect(low.className).toMatch(/above/)
  })

  it('never moves the maximum below a typed minimum that sits between stops', () => {
    // $470,000 rounds down to the $450,000 stop. Lowering the max handle must
    // stop at $470,000, or the next search would fail with min > max.
    const { onChange, high } = setup('470000', '500000')
    fireEvent.change(high, { target: { value: at(475_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '470000', max: '475000' })
    fireEvent.change(high, { target: { value: at(450_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '470000', max: '470000' })
  })

  it('never moves the minimum above a decimal maximum', () => {
    const { onChange, low, high } = setup('', '500000.50')
    expect(high).toHaveValue(at(500_000))
    expect(high).toHaveAttribute('aria-valuetext', '$500,000.50')
    fireEvent.change(low, { target: { value: at(600_000) } })
    // Before the fix the decimal max counted as "no max", so this sent 600000.
    expect(onChange).toHaveBeenLastCalledWith({ min: '500000', max: '500000.50' })
    fireEvent.change(low, { target: { value: at(400_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '400000', max: '500000.50' })
  })

  it('treats an unreadable other end as no limit', () => {
    const { onChange, low } = setup('', 'abc')
    fireEvent.change(low, { target: { value: at(600_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '600000', max: 'abc' })
  })

  it('keeps a typed maximum above its range when the low handle moves', () => {
    const { onChange, low, high } = setup('', '80000000')
    expect(high).toHaveValue(String(LAST_STOP))
    fireEvent.change(low, { target: { value: at(300_000) } })
    expect(onChange).toHaveBeenLastCalledWith({ min: '300000', max: '80000000' })
  })
})
