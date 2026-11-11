// Sun position for the house in Windhoek. Low-precision astronomical
// almanac formulas (good to about 0.1 degree), no dependencies.

export const SITE = {
  lat: -22.56,
  lon: 17.08,
  utcOffsetHours: 2, // Namibia is UTC+2 all year
  // The model's +Y axis points 6 degrees west of true north (fitted to the
  // street on the aerial photo, see ../README.md "Real surroundings").
  modelNorthOffsetDeg: 6,
};

const RAD = Math.PI / 180;

/** Azimuth (degrees clockwise from true north) and elevation for a UTC time in ms. */
export function sunPosition(utcMs, lat = SITE.lat, lon = SITE.lon) {
  const d = utcMs / 86400000 - 10957.5; // days since J2000.0
  const L = 280.46 + 0.9856474 * d;
  const g = (357.528 + 0.9856003 * d) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * d) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15 * RAD;
  const ha = gmst + lon * RAD - ra;
  const phi = lat * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { az: ((az / RAD) % 360 + 360) % 360, el: el / RAD };
}

/** UTC ms for a local Windhoek calendar day ("YYYY-MM-DD") and decimal hours. */
export function localToUtcMs(dayIso, hours) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + (hours - SITE.utcOffsetHours) * 3600000;
}

/** Unit vector towards the sun in the model's frame (x east-ish, y north-ish, z up). */
export function sunDirectionModel(az, el) {
  const a = (az + SITE.modelNorthOffsetDeg) * RAD;
  const e = el * RAD;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}
