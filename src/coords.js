// Convert WGS84 lat/lng (from GPS) to ETRS-TM35FIN (EPSG:3067) easting/northing.
// This is the coordinate system used in Finnish construction site DXF files.
// Uses the standard Transverse Mercator forward formula (GRS80 ellipsoid),
// which is accurate to within centimeters across Finland.

const a = 6378137.0          // GRS80 semi-major axis
const f = 1 / 298.257222101  // GRS80 flattening
const k0 = 0.9996
const lon0 = 27 * Math.PI / 180  // central meridian for TM35FIN (zone covers all of Finland)
const FE = 500000             // false easting
const FN = 0                  // false northing

const e2 = f * (2 - f)
const ePrime2 = e2 / (1 - e2)

function deg2rad(d) { return d * Math.PI / 180 }

export function latLngToTM35FIN(lat, lng) {
  const phi = deg2rad(lat)
  const lambda = deg2rad(lng)

  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2
  const C = ePrime2 * Math.cos(phi) ** 2
  const A = Math.cos(phi) * (lambda - lon0)

  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi)
  )

  const x = k0 * N * (
    A + (1 - T + C) * A ** 3 / 6
    + (5 - 18 * T + T ** 2 + 72 * C - 58 * ePrime2) * A ** 5 / 120
  ) + FE

  const y = k0 * (
    M + N * Math.tan(phi) * (
      A ** 2 / 2
      + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
      + (61 - 58 * T + T ** 2 + 600 * C - 330 * ePrime2) * A ** 6 / 720
    )
  ) + FN

  return { x, y }
}
