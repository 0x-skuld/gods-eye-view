# Tools and the MCP server

Tools answer questions from God's Eye View data for language-model clients.
They are defined once and exposed through adapters; the Model Context Protocol
(MCP) is the first.

## Layers

| Owner                | Responsibility                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `src/tools/`         | Tool definitions, catalog composition, argument validation, shared `area` and result helpers      |
| `src/tools/queries/` | Queries, one file per domain, reading only portable source contracts                              |
| `src/tools/mcp/`     | MCP protocol (JSON-RPC) and a stateless HTTP transport; knows the catalog interface, not queries |
| `src/tools/services.js` | The default services: the layers' source factories and request services, given a resolving fetch |
| `server/mcp/`        | Node composition: points the sources at a running app's `/api` routes; serves stdio and `/mcp`  |

Dependencies point downward only. `gods-eye-view/tools` and
`gods-eye-view/tools/mcp` are portable exports: they reach no application,
rendering, Node, Cesium or browser-global code, which
`npm run check:boundaries` enforces. Nothing in the application imports them.

## Definitions and composition

`defineTool({ name, kind, title, description, inputSchema, requires, run })`
validates and freezes a tool. `kind` is `query` (answers from data, read-only)
or `action`. `inputSchema` uses a JSON Schema subset that `src/tools/schema.js`
checks completely; unsupported keywords are rejected at definition time.
`run(args, { services, signal })` resolves to `{ summary, data }`: one sentence
for people and a structured object for programs. A tool may also return `images`,
each `{ mimeType, data }` with base64 data; the MCP adapter sends them as image
content.

`composeCatalog({ tools, services, replace, interceptors })` builds a catalog:

- **Tools**: an application adds its own tools to `coreTools`. Reusing a name
  fails unless the name is listed in `replace`.
- **Services**: each tool names the services it reads in `requires`. Tools
  whose services are not supplied are left out.
- **Interceptors**: `(call, next) => next(call)` functions wrap every call,
  outermost first. They can observe, reject or change a call.

Expected failures throw `ToolError` with one of `invalid_arguments`,
`unavailable`, `unsupported`, `malformed` or `retry_later`. Other errors are
reported to clients without details.

## Services

`gods-eye-view/tools/services` builds the default set with
`createToolServices({ fetchImpl, appUrl })`. Services are the portable source factories the layers already use, such as
`createUsgsEarthquakeSource`, `createFirmsSource` and `createLaunchSource`,
plus a `places` service with `resolve(name, { signal })`. Sources request
relative `/api/...` paths through an injected `fetchImpl`, so the same tool
code runs wherever an application routes those paths.
The `weather`, `regional`, `terrain`, `summary` and `features` services are the
application request services from `gods-eye-view/application/requests`.
`situation_brief` runs each section whose services are supplied and marks the
others unavailable. `app` is `{ baseUrl }`, the address links open. The `bikeshare` service is `{ systems, getStations }`: the system registry and
the GBFS source. `createGeocodePlaceService` resolves place names through `/api/geocode`;
`createPlaceSearchService` searches `/api/google/*` and reports when no search key
is configured; `createRouteService` plans routes through `/api/route`.

## The `area` argument

Location-scoped tools take `area` as exactly one of a `place` name, a `bbox`
(`[west, south, east, north]`, crossing the antimeridian when west exceeds
east), or `lat`, `lon` and `radius_km`. Lists default to 25 rows, at most 200,
and report `total`, `returned` and `truncated`.

## MCP

`createMcpServer({ catalog, name, version, instructions, descriptions, decorate })`
implements `initialize`, `ping`, `tools/list` and `tools/call` for protocol
revisions 2025-11-25, 2025-06-18 and 2025-03-26. `descriptions` overrides a
tool's title or description for this surface; `decorate(definition, tool)`
merges extra fields into each listed definition. `createMcpHttpHandler(server)`
returns a `Request`-to-`Response` handler for stateless Streamable HTTP: one
JSON-RPC message per POST, answered with JSON. The host owns routing and any
access control in front of it.

## Running locally

Start the app (`npm run dev` or `npm run preview`), then register the stdio
server with an MCP client, for example Claude Code:

```bash
claude mcp add gods-eye-view -- npm --prefix /path/to/gods-eye-view run --silent mcp
```

`npm run mcp -- --api-base http://localhost:4173` selects another server.

The development and preview servers also serve the same tools over HTTP at
`/mcp`, for clients that connect by URL:

```bash
claude mcp add --transport http gods-eye-view http://localhost:4173/mcp
```

The route accepts only requests from this machine that name a loopback host
and, when a browser sends an `Origin`, come from a loopback origin. This is
local transport safety, not authentication. The
local server makes no requests other than to the app's `/api` routes and the
public feeds the sources already use.

## Tools

| Tool                  | Reads         | Returns                                                       |
| --------------------- | ------------- | ------------------------------------------------------------- |
| `get_earthquakes`     | `earthquakes` | USGS M2.5+ events in the last 24 hours, strongest first        |
| `get_active_fires`    | `fires`       | NASA FIRMS detections in an area, highest radiative power first |
| `get_recent_launches` | `launches`    | Launch Library 2 launches in the last 30 days, newest first    |
| `aircraft_in_area`    | `aircraft`    | Aircraft in an area, nearest first; `military: true` reads the `military` feed |
| `find_aircraft`       | `aircraft`    | Aircraft anywhere by callsign, ICAO address or registration    |
| `get_aircraft_track`  | `aircraft`    | Recent positions of one aircraft, thinned to 200 points        |
| `get_aircraft_info`   | `aircraft`    | Aircraft type and registration, and flight route, from adsbdb  |
| `vessels_in_area` | `vessels` | Ships reported by AIS in an area, nearest first, optionally by type |
| `find_vessel` | `vessels` | Ships anywhere by MMSI, IMO number or name |
| `get_vessel_track` | `vessels` | Recent positions of one ship, thinned to 200 points |
| `next_satellite_pass` | `satellites` | Next pass over a point (default the ISS), with naked-eye visibility |
| `satellites_overhead` | `satellites` | Satellites in a CelesTrak group above a point now, highest first |
| `find_cctv_cameras` | `cctv` | Public cameras in an area, nearest first |
| `get_cctv_snapshot` | `cctv` | The current image from one camera, returned as image content |
| `find_radio_stations` | `radio` | Radio Browser stations by area and/or search terms, with stream URLs |
| `search_places` | `placeSearch` | Points of interest matching a query within an area (Google Places) |
| `places_nearby` | `placeSearch` | Notable places around a point (Google Places) |
| `plan_route` | `routing` | Walking, driving or cycling route over OpenStreetMap, with a simplified path |
| `get_bike_share` | `bikeshare` | Live GBFS stations in an area, with bikes and docks available |
| `get_transit_vehicles` | `transit` | Live GTFS-Realtime vehicle positions in an area, optionally one route |
| `get_traffic_flow` | `traffic` | TomTom flow in a city-sized area: speed vs free flow, congested and closed road |
| `get_weather` | `weather` | Current conditions at a place or point |
| `get_regional_brief` | `regional` | What and where a location is, its weather and recent headlines |
| `get_cyclones` | `cyclones` | Active NHC/CPHC tropical cyclones, optionally in an area |
| `get_fire_perimeters` | `perimeters` | Mapped WFIGS wildfire perimeters in an area, largest first |
| `get_terrain_height` | `terrain` | Ground, geoid and ellipsoid heights at up to 20 points |
| `find_military_installations` | `installations` | OpenStreetMap military sites in an area of at most 10° per side |
| `get_map_features` | `features` | Administrative areas, named places or monuments at a location (needs Overpass) |
| `situation_brief` | `weather` | Weather, earthquakes, fires, aircraft, ships and cyclones for an area, by section |
| `get_hud_caption` | `weather`, `summary` | The app's heads-up display caption for an area |
| `open_in_gods_eye_view` | `app` | A share link looking straight down on an area |
