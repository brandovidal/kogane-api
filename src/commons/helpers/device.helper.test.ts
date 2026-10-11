import { describeDevice, deviceOf } from './device.helper'

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
}

describe('describeDevice', () => {
  it.each([
    [UA.chromeMac, { browser: 'Chrome', os: 'macOS', kind: 'desktop' }],
    [UA.safariIphone, { browser: 'Safari', os: 'iOS', kind: 'mobile' }],
    [UA.chromeIphone, { browser: 'Chrome', os: 'iOS', kind: 'mobile' }],
    [UA.edgeWindows, { browser: 'Edge', os: 'Windows', kind: 'desktop' }],
    [UA.firefoxLinux, { browser: 'Firefox', os: 'Linux', kind: 'desktop' }],
    [UA.chromeAndroid, { browser: 'Chrome', os: 'Android', kind: 'mobile' }],
    [UA.ipad, { browser: 'Safari', os: 'iOS', kind: 'tablet' }],
  ])('should name %#', (userAgent, expected) => {
    expect(describeDevice(userAgent)).toEqual(expected)
  })

  it('should not fail without a user agent', () => {
    expect(describeDevice(null)).toEqual({ browser: 'Navegador', os: 'Sistema desconocido', kind: 'unknown' })
  })
})

describe('deviceOf', () => {
  it('should take the first address of x-forwarded-for and cut a very long user agent', () => {
    const device = deviceOf({
      headers: { 'user-agent': 'x'.repeat(500), 'x-forwarded-for': '190.1.2.3, 10.0.0.1' },
      ip: '10.0.0.9',
    })

    expect(device.ipAddress).toBe('190.1.2.3')
    expect(device.userAgent).toHaveLength(255)
  })

  it('should fall back to the socket address and to nothing', () => {
    expect(deviceOf({ headers: {}, ip: '10.0.0.9' })).toEqual({ userAgent: null, ipAddress: '10.0.0.9' })
    expect(deviceOf({ headers: {}, ip: undefined })).toEqual({ userAgent: null, ipAddress: null })
  })
})
