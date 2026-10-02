# Tools and the MCP server

Tools answer questions from God's Eye View data for language-model clients.
They are defined once and exposed through adapters: the Model Context Protocol
(MCP) and function calling, which voice uses.

## Layers

| Owner                | Responsibility                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `src/tools/`         | Tool definitions, catalog composition, argument validation, shared `area` and result helpers      |
| `src/tools/queries/` | Queries, one file per domain, reading only portable source contracts                              |
| `src/tools/mcp/`     | MCP protocol (JSON-RPC) and a stateless HTTP transport; knows the catalog interface, not queries |
| `src/tools/functions.js` | Function-calling adapter: tool records and results for function-calling clients |
| `src/tools/services.js` | The default services: the layers' source factories and request services, given a resolving fetch |
| `server/mcp/`        | Node composition: points the sources at a running app's `/api` routes; serves stdio and `/mcp`  |
| `server/standalone/voiceTools.js`, `src/standalone/toolCatalog.js` | Standalone voice composition: the session's tool list and the browser catalog |

Dependencies point downward only. `gods-eye-view/tools` and
`gods-eye-view/tools/mcp` are portable exports: they reach no application,
rendering, Node, Cesium or browser-global code, which
`npm run check:boundaries` enforces. In the application, only voice reaches
them: `withToolCatalog` in `src/voice/gevRealtime.js` imports the
function-calling adapter, and the standalone entry supplies the catalog.

## Definitions and composition

`defineTool({ name, kind, title, description, inputSchema, requires, run })`
validates and freezes a tool. `kind` is `query` (answers from data, read-only)
or `action`. `inputSchema` uses a JSON Schema subset that `src/tools/schema.js`
checks completely; unsupported keywords are rejected at definition time.
`run(args, { services, signal })` resolves to `{ summary, data }`: one sentence
for people and a structured object for programs. A tool may also return `images`,
each `{ mimeType, data }` with base64 data; the MCP adapter sends them as image
content. MCP results carry the summary and the data as JSON text, plus the data
as `structuredContent`, for clients that read only one of them.

`composeCatalog({ tools, services, replace, interceptors })` builds a catalog:

- **Tools**: an application adds its own tools to `coreTools`. Reusing a name
  fails unless the name is listed in `replace`.
- **Services**: each tool names the services it reads in `requires`. Tools
  whose services are not supplied are left out.
- **Interceptors**: `(call, next) => next(call)` functions wrap every call,
  outermost first. They can observe, reject or change a call.
- **Composite tools**: `run` receives `tools`, with `has(name)` and
  `call(name, args)`, to call other tools through the same catalog, so
  replaced tools and interceptors apply. Interceptors see such calls with
  `parent`, the calling tool's name.

### Surfaces

`src/tools/surfaces.js` lists which tools MCP and voice offer. A tool is on
both unless `TOOL_SURFACES` turns it off; edit an entry to turn a tool on or
off for one surface. MCP leaves out place search, routing, plain
weather and wind, the regional brief, the HUD caption, radio, bike share and
transit, which assistants already cover or which add little without the
globe. `catalogForSurface(catalog, surface, overrides)` is the
view a surface exposes: it lists and calls only the tools it offers, while
composite tools still reach the whole catalog. `toolsForSurface` gives the
same selection as a list of definitions, such as for the voice session's tool
list. Voice leaves out tools that answer with images, link to the app, or
repeat what its app actions answer.

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
`situation_brief` and `military_awareness` run each section whose services are supplied and mark the
others unavailable. `app` is `{ baseUrl }`, the address links open. The `bikeshare` service is `{ systems, getStations }`: the system registry and
the GBFS source. `createGeocodePlaceService` resolves place names through `/api/geocode`;
`createPlaceSearchService` searches `/api/google/*` and reports when no search key
is configured; `createRouteService` plans routes through `/api/route`.

## Views

`gods-eye-view/view` (`src/view/index.js`) describes what the app shows,
independent of how it is shown: a camera (lat, lon, altitude, heading,
pitch), data layers, visual style, map imagery, and an aircraft, military
aircraft or satellite to follow. `createView` builds and bounds one,
`viewToParams` and `viewFromParams` write and read it in the share-link
format the app restores, and `viewUrl` gives the address that opens it. The
style names are the ones share links use. Ships cannot be followed from a
link yet.

A view can also carry `annotations`, the marks the app's `annotate_map`
action draws (pins, highlights, areas, arrows, routes and labels at a place
name or coordinates). Links carry them in the `an` parameter, and the app
draws them once the link has been restored.

Tools take a view as `VIEW_ARGUMENTS`: an `area` to frame from above, or a
`camera`, plus `layers`, `style`, `map`, `follow` and `annotations`. A
tilted camera over an area looks at its center from behind; camera fields
given with an area override its framing. `resolveViewArguments` turns them
into a view.

### Embed mode

`?embed=1` shows only the globe: clean view, with the HUD, panels, welcome
and setup prompts hidden; provider attribution stays. A page that frames it
changes the view by posting `{ type: 'gev:view', id, view }` to the frame.
The app applies it through its own actions (style, map, exactly the view's
layers, annotations, the camera, then the followed entity, retried until its
layer has it) and answers `{ type: 'gev:view-applied', id, ok, steps }`. It
posts `{ type: 'gev:ready' }` once it can take views, and only its parent
page can send them. See `src/app/embed.js`.

The development and preview servers let other pages frame embed-mode
documents only; every other document keeps `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. `GEV_EMBED_FRAME_ANCESTORS` restricts which pages
may frame them (any by default).

Answers that have something to show include `data.view`: the view that
shows them, with the matching layers on, an area framed from above, and a
single aircraft or satellite followed, plus `url` to open it (null when the
app's address is not configured). `suggestView` in `src/tools/views.js`
builds one.

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

## Voice

Voice offers the catalog's queries next to its app actions.
`toFunctionTools(tools, { exclude })` turns tools into
`{ type: 'function', name, description, parameters }` records, and
`toFunctionOutput(name, result)` turns a result into
`{ ok, tool, summary, data }`, counting images in `images_omitted` instead of
sending them.

The voice session token endpoint takes its tool list as `realtime.tools`.
`realtimeSessionTools(additional)` appends function tools to the app actions,
skipping names an action already uses, so `next_satellite_pass` stays the
action. The standalone server supplies the core queries that
`src/tools/surfaces.js` offers on voice, which leaves out tools that answer
with images, link to the app, or repeat what voice's app actions answer
(aircraft, ships, earthquakes, fires, datacenters, dams and satellites
overhead, which `analyst_query` covers).

In the browser, `initGevVoiceCommands({ toolCatalog })` takes a function that
resolves a catalog. App action names go to the action runner; other names the
catalog has go to `catalog.call` with the call's abort signal. The standalone
entry composes the catalog with `createToolServices` over the page's fetch and
loads it the first time voice calls a query.

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
| `next_satellite_pass` | `satellites` | Next pass over a place or point (default the ISS), with naked-eye visibility |
| `satellites_overhead` | `satellites` | Satellites in a CelesTrak group above a place or point now, highest first |
| `find_cctv_cameras` | `cctv` | Public cameras in an area, nearest first |
| `get_cctv_snapshot` | `cctv` | The current image from one camera, returned as image content |
| `find_alpr_cameras` | `alpr` | OpenStreetMap-mapped license plate readers in a US/Canadian area up to 3° |
| `find_radio_stations` | `radio` | Radio Browser stations by area and/or search terms, with stream URLs |
| `search_places` | `placeSearch` | Points of interest matching a query within an area (Google Places) |
| `places_nearby` | `placeSearch` | Notable places around a place or point (Google Places) |
| `plan_route` | `routing` | Walking, driving or cycling route over OpenStreetMap, with a simplified path |
| `get_bike_share` | `bikeshare` | Live GBFS stations in an area, with bikes and docks available |
| `get_transit_vehicles` | `transit` | Live GTFS-Realtime vehicle positions in an area, optionally one route |
| `get_traffic_flow` | `traffic` | TomTom flow in a city-sized area: speed vs free flow, congested and closed road |
| `get_weather` | `weather` | Current conditions at a place or point |
| `get_weather_map` | `weatherMaps` | The latest NOAA radar, satellite or lightning map image over an area |
| `get_wind` | `wind` | GFS or IFS model wind 10 m above ground at a location |
| `get_recent_imagery` | `imagery` | The most recent clear Landsat/Sentinel-2 image of an area (VIIRS fallback) |
| `find_submarine_cables` | `cables` | TeleGeography cables and landing points by area or name (CC BY-NC-SA 3.0) |
| `find_infrastructure` | `infrastructure` | OpenStreetMap datacenters or dams in an area, nearest first (ODbL) |
| `get_bhote_koshi_flood` | `events` | The 2026 Bhote Koshi flood: evidence trail in story order, flood path and imagery dates (CC BY-NC 4.0) |
| `get_regional_brief` | `regional` | What and where a location is, its weather and recent headlines |
| `get_cyclones` | `cyclones` | Active NHC/CPHC tropical cyclones, optionally in an area |
| `get_fire_perimeters` | `perimeters` | Mapped WFIGS wildfire perimeters in an area, largest first |
| `get_terrain_height` | `terrain` | Ground, geoid and ellipsoid heights at up to 20 points |
| `find_military_installations` | `installations` | OpenStreetMap military sites in an area of at most 10° per side |
| `get_map_features` | `features` | Administrative areas, named places or monuments at a location (needs Overpass) |
| `situation_brief` | `weather` | Weather, earthquakes, fires, aircraft, ships and cyclones for an area, by section |
| `military_awareness` | `military` | Military and other aircraft, ships and military installations within 250 km of a point, by section |
| `get_hud_caption` | `weather`, `summary` | The app's heads-up display caption for an area |
| `open_in_gods_eye_view` | `app` | A share link to a view: an area or camera, layers, style, map, and an aircraft or satellite to follow |
