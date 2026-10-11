import { Request } from 'express'

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface SessionDevice {
  userAgent: string | null
  ipAddress: string | null
}

export interface DeviceDescription {
  browser: string
  os: string
  kind: DeviceKind
}

// The first rule that matches wins: Edge, Opera and the browsers of iOS also say "Chrome" or "Safari"
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

const MAX_USER_AGENT = 255

// A readable name for the list of devices ("Chrome · macOS"). Not a security signal: the header is whatever the client
// sends, so it only helps the person recognize their own sessions
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = userAgent ?? ''
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Navegador'
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Sistema desconocido'
  const kind: DeviceKind = /iPad|Tablet/.test(ua)
    ? 'tablet'
    : /iPhone|iPod|Android.*Mobile|Mobile/.test(ua)
      ? 'mobile'
      : ua
        ? 'desktop'
        : 'unknown'
  return { browser, os, kind }
}

// Behind the web's proxy and Railway the address is the first of x-forwarded-for
export function deviceOf(req: Pick<Request, 'headers' | 'ip'>): SessionDevice {
  const agent = req.headers['user-agent']
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return {
    userAgent: agent ? agent.slice(0, MAX_USER_AGENT) : null,
    ipAddress: first || req.ip || null,
  }
}
