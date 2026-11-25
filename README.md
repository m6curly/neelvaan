# NEELVAAN

NEELVAAN is a browser-based geospatial workspace. Open `index.html` through a local static server or deploy the folder to a static host. The shared map displays imported data, OSM history, raster-analysis results and map drawings.

## Workspace layout

- **Top navigation:** Add Data, Base Map and Analysis live in the bar below the NEELVAAN header. OSM History, Change Detection and LST open as separate, closable workspaces; their generated outputs are added to Map Content.
- **Map Content:** a wider, persistent layer panel beside the map. Drag the divider to resize it, or collapse it to a compact strip. Use the eye control to show or hide a layer, drag rows to change their actual map drawing order, and use the three-dot menu to zoom, rename, edit, export, reorder or remove a layer. General layer editing includes opacity; place marks can also be edited in detail. The active basemap participates in the same layer stack. Reordering is animated and shows an insertion cue.
- **Map drawing:** a compact icon-only toolbar sits at the right side of the map; labels appear on hover or keyboard focus. Select uses the standard mouse-pointer cursor, Pan enables map dragging, and Point (Place Mark), Line (Path), Polygon and Measure create map features. Finished drawings are added to Map Content.
- **Place Mark layers:** the Place Mark form asks for a layer before the place name. Choose **Create new layer** and enter its name, or select an existing layer to add more marks to it. Named place-mark layers and their point data persist in this browser using local storage and can be exported from Map Content.
- **Map navigation:** the compass and rotation controls are removed. Zoom in/out remain at the lower-right of the map. Scale, camera estimate, latitude, longitude, elevation and active-provider attribution share one footer bar.
- **Default basemap:** NEELVAAN starts with Esri World Imagery satellite imagery, with attribution supplied by the active basemap. Other map styles remain available in Base Map. Google satellite imagery is not embedded through an unofficial tile URL; production Google imagery requires the supported Google Maps Platform setup, including a valid key/session and billing.
- **NEELVAAN identity:** the header mark is a satellite-textured Earth globe without a cloud overlay. The surface scrolls slowly inside a shaded circular sphere to show longitudes from the India/Asia region through the Americas.
- **Add Data:** GeoJSON (`.geojson` or `.json`) import is supported now. Shapefile, KML, CSV and GeoPackage are future additions, not active import formats in this release.
- **Google Drive connection:** the header provides a Google OAuth connection flow using Google Identity Services. It requests `openid`, `email`, `profile` and the least-privilege `drive.file` scope. This scope only grants access to files created/opened with NEELVAAN; it does not grant access to every file in a user’s Drive. Configure the Web OAuth Client ID in `google-config.js`, enable the Drive API in Google Cloud Console, add the deployed origin to Authorized JavaScript origins, and complete any required OAuth consent-screen verification before using the button. OAuth tokens remain in memory for the current tab; this release does not yet upload or synchronize workspace layers automatically.

## Data handling

This release has no NEELVAAN account system, server-side project database or cloud file storage. Source raster and GeoJSON files are read and processed in the browser. OSM requests, place searches, map tiles, terrain elevation lookups and browser libraries contact their respective external providers when used; those providers may process request metadata under their own terms. Exported files are saved to the user's device.

There is no server-side project database or NEELVAAN cloud sync in this release. Named place-mark layers are retained in this browser using local storage, scoped to this browser and website origin; they are not shared with other devices or users. Other map analysis layers and temporary processing state remain in memory. Export important layers and keep local copies of source files and outputs.

## Google OAuth setup

1. Create a Google Cloud project and a Web application OAuth 2.0 Client ID.
2. Enable the Google Drive API and configure the OAuth consent screen.
3. Add `http://localhost:8000` and your production website origin to Authorized JavaScript origins.
4. Set `googleClientId` in `google-config.js` to the Web Client ID. Do not add a client secret to this browser-only app.
5. Deploy and test sign-in on an authorized HTTPS origin. The app requests only the `drive.file` Drive scope.

Google’s branding and OAuth policies apply. Production use may require app verification depending on the requested scopes and audience.

## Run locally

Requirements: a modern browser and internet access for map tiles, OSM APIs, geocoding and CDN-hosted libraries.

```bash
# From the project folder, use any static file server, for example:
python -m http.server 8000
```

Then open `http://localhost:8000`. No application backend or environment variables are required for the current tools.

## Validation

```bash
npm test
npm run check
```

The tests cover raster processing helpers, core page structure, unique IDs, local asset references and the browser-based workspace structure. They do not replace browser testing with representative OSM data and GeoTIFF files.

## Important data notes

- OSM data is © OpenStreetMap contributors and is available under the Open Database License (ODbL) 1.0. Keep attribution and licence metadata with exported data.
- Public basemap, geocoding, elevation and Overpass endpoints have separate terms, rate limits and availability. Attribution is provided by the selected basemap. The OSM Standard tile service must not be bulk-scraped or used to build offline tile packages. Terrain elevation is approximate and comes from Copernicus DEM GLO-90 at approximately 90 m resolution through Open-Meteo.
- Change detection requires aligned rasters with matching CRS, extent, pixel size and dimensions. It does not perform image registration or atmospheric correction.
- LST output is satellite-derived land surface temperature, not near-surface air temperature. Review QA masking and source metadata before relying on results.
- Do not use analytical outputs as the sole basis for safety-critical, legal-boundary or other high-impact decisions without independent verification.

## Before public launch

`legal.html` still contains operator and contact placeholders. Replace them with accurate, monitored details and obtain a jurisdiction-appropriate legal review. Confirm hosting logs, external-provider terms and the actual data-handling practices of the deployed service.
