import { describe, it, expect } from 'vitest';
import { parseEndpointText, formatLatLon } from './coords';

describe('parseEndpointText', () => {
  it('reads the "lat, lon" form map apps show', () => {
    expect(parseEndpointText('-23.50150, -47.45260')).toEqual({
      kind: 'coords',
      value: { lat: -23.5015, lon: -47.4526 },
    });
  });

  it('accepts the separators people actually paste', () => {
    for (const text of ['-23.5015,-47.4526', '-23.5015, -47.4526', '-23.5015 -47.4526', '  -23.5015 , -47.4526  ']) {
      expect(parseEndpointText(text), text).toEqual({ kind: 'coords', value: { lat: -23.5015, lon: -47.4526 } });
    }
  });

  it('tolerates the @ a Google Maps URL puts in front of the pair', () => {
    expect(parseEndpointText('@-23.5015,-47.4526')).toEqual({
      kind: 'coords',
      value: { lat: -23.5015, lon: -47.4526 },
    });
  });

  it('handles integers and the equator/prime meridian', () => {
    expect(parseEndpointText('0, 0')).toEqual({ kind: 'coords', value: { lat: 0, lon: 0 } });
    expect(parseEndpointText('51, -1')).toEqual({ kind: 'coords', value: { lat: 51, lon: -1 } });
  });

  it('accepts the poles and the date line exactly', () => {
    expect(parseEndpointText('90, 180').kind).toBe('coords');
    expect(parseEndpointText('-90, -180').kind).toBe('coords');
  });

  it('treats anything else as a place name', () => {
    for (const text of ['Sorocaba, SP', 'Monte Verde', '221B Baker Street', 'Route 66']) {
      expect(parseEndpointText(text), text).toEqual({ kind: 'place', query: text });
    }
  });

  it('does not mistake a house number for a coordinate pair', () => {
    // Three components, so it cannot be a pair — this is the case that would
    // otherwise silently bake a race starting in the Gulf of Guinea.
    expect(parseEndpointText('12, 34, 56').kind).toBe('place');
  });

  it('rejects an out-of-range latitude rather than geocoding it', () => {
    const result = parseEndpointText('120, 45');
    expect(result.kind).toBe('invalid');
    // 120 is a valid *longitude*, and 45 a valid latitude, so this is almost
    // certainly a lon,lat pair — say so.
    expect(result.kind === 'invalid' && result.reason).toMatch(/lat first/);
    expect(result.kind === 'invalid' && result.reason).toContain('45, 120');
  });

  it('rejects a latitude that is not a swapped pair either', () => {
    const result = parseEndpointText('500, 600');
    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.reason).toMatch(/Latitude must be/);
  });

  it('rejects an out-of-range longitude', () => {
    const result = parseEndpointText('-23.5, -470');
    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.reason).toMatch(/Longitude must be/);
  });

  it('rejects empty input', () => {
    expect(parseEndpointText('   ').kind).toBe('invalid');
  });
});

describe('formatLatLon', () => {
  it('round-trips through the parser', () => {
    const point = { lat: -23.5015, lon: -47.4526 };
    expect(parseEndpointText(formatLatLon(point))).toEqual({ kind: 'coords', value: point });
  });

  it('pads to a metre of precision', () => {
    expect(formatLatLon({ lat: -23.5, lon: -47 })).toBe('-23.50000, -47.00000');
  });
});
