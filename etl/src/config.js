import { existsSync, readFileSync } from 'node:fs';

/** Locations come from the LOCATIONS_JSON env var (CI) or config/locations.json (local). */
export function loadLocations(path = 'config/locations.json') {
  let raw = process.env.LOCATIONS_JSON;
  if (!raw) {
    if (!existsSync(path)) {
      throw new Error(`No locations configured. Set LOCATIONS_JSON or create ${path} (see config/locations.example.json).`);
    }
    raw = readFileSync(path, 'utf8');
  }
  const parsed = JSON.parse(raw);
  const locations = Array.isArray(parsed) ? parsed : parsed.locations;
  if (!Array.isArray(locations) || !locations.length) throw new Error('Location config has no locations');
  for (const l of locations) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(l.id ?? '')) throw new Error(`Location id "${l.id}" must be 1-16 letters/digits`);
    if (!l.name) throw new Error(`Location ${l.id} needs a name`);
    // Optional opening day: nothing before it is synced, and anything already stored before it is removed.
    if (l.startDate !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(l.startDate) && !Number.isNaN(Date.parse(`${l.startDate}T00:00:00Z`)))) {
      throw new Error(`Location ${l.id} startDate "${l.startDate}" must be a date like 2026-11-12`);
    }
  }
  return locations;
}
