import { describe, expect, test } from 'vitest'
import { CanonicalJsonError, canonicalize } from '../../src/main/identity/canonical'

function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

describe('RFC 8785 Appendix B: IEEE-754 number serialization', () => {
  const vectors: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2']
  ]
  test.each(vectors)('%s -> %s', (bits, expected) => {
    expect(canonicalize(fromBits(bits))).toBe(expected)
  })

  test.each([['7fffffffffffffff'], ['7ff0000000000000'], ['fff0000000000000']])('%s (NaN/Infinity) is rejected', (bits) => {
    expect(() => canonicalize(fromBits(bits))).toThrow(CanonicalJsonError)
  })
})

describe('RFC 8785 §3.2.2 example (literals, numbers, string escaping)', () => {
  test('matches the RFC output byte for byte', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false]}'
    )
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
    )
  })
})

describe('RFC 8785 §3.2.3 property sorting (UTF-16 code units)', () => {
  test('sorts as in the RFC example, emoji (surrogates) before U+FB33', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
        '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}'
    )
    // Order is asserted on the string itself: Object.keys would hoist integer-like keys.
    expect(canonicalize(input)).toBe(
      '{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"\u00f6\":\"Latin Small Letter O With Diaeresis\",' +
        '\"\u20ac\":\"Euro Sign\",\"\ud83d\ude00\":\"Emoji: Grinning Face\",\"\ufb33\":\"Hebrew Letter Dalet With Dagesh\"}'
    )
  })

  test('nested objects sorted recursively, arrays keep order, no whitespace', () => {
    expect(canonicalize({ b: [3, { z: 1, a: 2 }], a: { y: null, x: true } })).toBe('{"a":{"x":true,"y":null},"b":[3,{"a":2,"z":1}]}')
  })

  test('integer-like keys are sorted as strings, not numbers', () => {
    expect(canonicalize({ '10': 1, '9': 2, '1': 3 })).toBe('{"1":3,"10":1,"9":2}')
  })
})

describe('string edge cases', () => {
  test('control characters use lowercase \\u escapes; DEL and non-ASCII stay literal', () => {
    expect(canonicalize('\u0000\u001f\u007f\u2028\u00e9')).toBe('"\\u0000\\u001f\u007f\u2028\u00e9"')
  })
  test('short escapes', () => {
    expect(canonicalize('\b\t\n\f\r"\\/')).toBe('"\\b\\t\\n\\f\\r\\"\\\\/"')
  })
  test('lone surrogates are rejected (I-JSON)', () => {
    expect(() => canonicalize('\ud83d')).toThrow(CanonicalJsonError)
    expect(() => canonicalize('a\ude00b')).toThrow(CanonicalJsonError)
    expect(() => canonicalize({ ['\ud800']: 1 })).toThrow(CanonicalJsonError)
  })
})

describe('non-JSON input is rejected, never coerced', () => {
  test.each([
    ['undefined', undefined],
    ['undefined member', { a: undefined }],
    ['function', () => 1],
    ['bigint', 1n],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map()]
  ])('%s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalJsonError)
  })
  test('cycles', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => canonicalize(a)).toThrow(CanonicalJsonError)
  })
  test('repeated (non-cyclic) references are fine', () => {
    const shared = { k: 1 }
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}')
  })
})
