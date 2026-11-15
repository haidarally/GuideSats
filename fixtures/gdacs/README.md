# GDACS fixtures (recorded, unmodified)

Recorded on 2026-11-15 at 19:54 UTC from the public GDACS event API (no key, read only):

| File | Query (`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?...`) | What it holds |
|---|---|---|
| `tc-2024-01-belal.json` | `eventlist=TC&fromDate=2024-01-10&toDate=2024-01-20` | BELAL-24, **Orange**, affected countries include **MUS** (positive case) |
| `tc-2023-02-freddy.json` | `eventlist=TC&fromDate=2023-02-15&toDate=2023-02-25` | FREDDY-23, Red, MOZ + MDG (not Mauritius) |
| `tc-2025-02-garance-honde.json` | `eventlist=TC&fromDate=2025-02-20&toDate=2025-03-05` | GARANCE-25 (Red, REU) and HONDE-25 (Orange, MDG) |
| `tc-2024-03-gamane-filipo.json` | `eventlist=TC&fromDate=2024-02-01&toDate=2024-03-31` | GAMANE-24 (Orange, MDG), FILIPO-24 (Orange, MOZ...) |

Negative cases that GDACS did not give us in these windows (a Green alert, a non-cyclone event)
are derived from the Belal record inside the tests and are labelled SYNTHETIC there.

Data: GDACS, the Global Disaster Alert and Coordination System, a cooperation framework of the
United Nations and the European Commission (https://www.gdacs.org).
