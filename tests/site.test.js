'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }

const pages = ['index.html', 'history.html', 'change-detection.html', 'lst.html', 'legal.html'];

test('the main page provides one shared map and all workspace tools', () => {
  const html = read('index.html');
  assert.match(html, /id="map"/);
  assert.match(html, /id="workspaceLayersList"/);
  assert.doesNotMatch(html, /workspaceLayerCount|class="layer-count"/, 'layer count is removed from Map Content');
  for (const id of ['layersPanel', 'osmPanel', 'changePanel', 'lstPanel', 'basemapPanel']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(html, /data-open-panel="addData"/, 'Add Data is in the second navigation row');
  assert.match(html, /data-open-panel="basemap"/, 'Base Map is in the second navigation row');
  for (const tool of ['osm', 'change', 'lst']) {
    assert.match(html, new RegExp(`data-analysis-panel="${tool}"`), `${tool} analysis tool exists`);
  }
  assert.match(html, /id="workspaceModal"/);
  assert.match(html, /id="workspaceModalClose"/);
  assert.match(html, /id="sidebarResizer"/);
  assert.match(html, /id="googleLoginBtn"/);
  assert.match(html, /id="geojsonFile"/);
  assert.doesNotMatch(html, /data-panel="help"|id="helpPanel"|<nav aria-label="Workspace navigation"/);
  for (const script of ['raster-core.js', 'app.js', 'change-detection.js', 'lst.js']) {
    assert.match(html, new RegExp(`src="${script}"`), `${script} is loaded`);
  }
  assert.match(html, /href="vaanam-theme\.css"/);
  assert.match(html, /href="workspace-ui\.css"/);
  assert.match(html, /href="workspace-polish\.css"/);
  assert.match(html, /class="workspace-menubar"/);
  assert.match(html, /id="analysisMenuBtn"/);
  assert.match(html, /<div[^>]*(?:id="workspaceModal"[^>]*hidden|hidden[^>]*id="workspaceModal")[^>]*>/);
  assert.doesNotMatch(html, /workspaceOpenBtn|class="workspace-open-button"/);
});


test('map opens first and analysis tools are grouped under the second navigation bar', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.ok(html.indexOf('class="topbar"') < html.indexOf('class="workspace-menubar"'));
  assert.ok(html.indexOf('class="workspace-menubar"') < html.indexOf('<main class="app-shell"'));
  assert.match(html, /<div aria-label="Analysis tools" class="analysis-dropdown" hidden id="analysisMenu"/);
  assert.match(app, /const hasRequestedPanel =/);
  assert.match(app, /showPanel\(initialPanel, hasRequestedPanel\)/);
  assert.match(app, /function openWorkspaceModal/);
  assert.doesNotMatch(html, /MAP WORKSPACE/);
  assert.match(html, /vaanam-brand-symbol/);
});


test('satellite imagery is the default and active provider attribution is dynamic', () => {
  const app = read('app.js');
  assert.match(app, /basemap: 'imagery'/);
  assert.match(app, /setBasemap\('imagery'\)/);
  assert.match(app, /label: 'Satellite · Esri \/ Maxar'/);
  assert.match(app, /map\.createPane\(entry\.paneName\)/);
  assert.match(app, /pane\.style\.zIndex/);
  assert.match(app, /workspaceLayerOrder\.slice\(\)\.reverse\(\)/);
  assert.match(app, /workspaceLayerOrder\.unshift\(id\)/);
  assert.match(app, /row\.draggable = true/);
  assert.match(app, /position = 'fixed'/);
});

test('right-side drawing rail uses a plain pointer-select tool and no North/rotation controls', () => {
  const html = read('index.html');
  const polish = read('workspace-polish.css');
  assert.match(html, /data-tooltip="Select"[^>]*id="arrowToolBtn"/);
  assert.doesNotMatch(html, /compass-face|compass-needle|rotateBtn|rotationPanel|rotateOptionBtn|resetNorthBtn/);
  assert.doesNotMatch(read('app.js'), /setDrawingMode\('arrow'\)|createArrowLayer/);
  assert.match(html, /class="vaanam-earth-spin"/);
  assert.match(polish, /inset: 0 0 0 auto/);
  assert.match(polish, /\.map-draw-tool::before \{ display: none/);
  assert.match(polish, /animation: vaanamEarthTurn 32s linear infinite/);
  assert.match(polish, /\.map-footer-metrics/);
  assert.doesNotMatch(html, /id="workspaceLayerCount"|MAP WORKSPACE|OSM data ©/);
});


test('Map Content menus open beside the panel where space allows and remain viewport-safe', () => {
  const app = read('app.js');
  const polish = read('workspace-polish.css');
  assert.match(app, /const preferredLeft = anchor\.right \+ 8/);
  assert.match(app, /const roomAbove = Math\.max\(0, anchor\.top - 10\)/);
  assert.match(app, /const lowestPaneZ = 205/);
  assert.match(polish, /--map-content-width: 356px/);
  assert.match(polish, /\.workspace-layer-row\.drop-before::before/);
  assert.match(polish, /\.workspace-layer-row\.drop-after::after/);
});

test('old tool URLs route into the corresponding panel of the shared workspace', () => {
  assert.match(read('history.html'), /index\.html#osm/);
  assert.match(read('change-detection.html'), /index\.html#change/);
  assert.match(read('lst.html'), /index\.html#lst/);
});

test('page element IDs are unique', () => {
  for (const filename of pages) {
    const html = read(filename);
    const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `${filename} duplicate ids`);
  }
});

test('local page links and script/style references exist', () => {
  for (const filename of pages) {
    const html = read(filename);
    const refs = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]);
    for (const ref of refs) {
      if (!ref || ref.startsWith('#') || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
      const local = decodeURIComponent(ref.split('#')[0].split('?')[0]);
      if (local) assert.equal(fs.existsSync(path.join(root, local)), true, `${filename} missing ${local}`);
    }
  }
});

test('obsolete server and cloud-storage backend files are absent while Google OAuth remains client-side', () => {
  assert.equal(fs.existsSync(path.join(root, 'api')), false);
  assert.equal(fs.existsSync(path.join(root, 'vaanam-cloud.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'google-config.js')), true);
  assert.match(read('index.html'), /google-config\.js/);
});


test('the map footer exposes scale, camera, decimal coordinates, elevation and legal credits', () => {
  const html = read('index.html');
  for (const id of ['mapScaleSlot', 'footerCamera', 'footerLatitude', 'footerLongitude', 'footerElevation', 'mapAttributionSlot']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(html, /© 2026 NEELVAAN/);
  assert.match(html, /legal\.html#data/);
  assert.doesNotMatch(html, /OSM data ©|ODbL 1\.0/, 'base map credits are not hard-coded');
  assert.equal((html.match(/class="map-footer"/g) || []).length, 1, 'there is one compact footer bar');
  assert.match(read('app.js'), /label: 'Satellite · Esri \/ Maxar'/);
  assert.match(html, /Copernicus DEM GLO-90/);
  assert.match(read('app.js'), /lat\.toFixed\(6\)/);
  assert.match(read('app.js'), /lon\.toFixed\(6\)/);
});

test('draw-area, fullscreen, OSM bulk-download and export-centre controls are removed', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.doesNotMatch(html, /drawNodeBboxBtn|bboxHistoryPanel|fitBtn|exportDialog|exportBtn|downloadPanel|data-panel="download"/);
  assert.doesNotMatch(app, /initNodeBboxTool|bboxHistory|bboxCurrentRectangle|drawNodeBboxBtn|fitBtn|exportDialog|exportBtn|downloadPanel/);
  assert.doesNotMatch(read('home.css'), /extract-section-title|downloadMap|download-layout|home-download-section/);
  assert.doesNotMatch(read('legal.html'), /OSM Data Download/);
  assert.equal(fs.existsSync(path.join(root, 'data-extract.js')), false);
});

test('map navigation controls retain zoom only; North and rotation are removed', () => {
  const html = read('index.html');
  const start = html.indexOf('<div aria-label="Map zoom controls"');
  const end = html.indexOf('<footer class="map-footer"', start);
  const controls = html.slice(start, end);
  assert.ok(controls.indexOf('id="zoomInBtn"') < controls.indexOf('id="zoomOutBtn"'));
  assert.doesNotMatch(controls, /rotate|north|compass/i);
  assert.doesNotMatch(read('app.js'), /applyMapRotation|setBearing|syncNorthIndicator/);
  assert.doesNotMatch(html, /leaflet-rotate@0\.6\.2/);
});

test('OSM import, version timeline and Inspector live only in the OSM History panel', () => {
  const html = read('index.html');
  const layers = html.slice(html.indexOf('id="layersPanel"'), html.indexOf('</section>', html.indexOf('id="layersPanel"')));
  const osm = html.slice(html.indexOf('id="osmPanel"'), html.indexOf('id="basemapPanel"'));
  for (const id of ['xmlFile', 'osmImportBtn', 'layersEmpty', 'yearGroups', 'rightPanel', 'rightContent']) {
    assert.match(osm, new RegExp(`id="${id}"`), `${id} in OSM History`);
    assert.doesNotMatch(layers, new RegExp(`id="${id}"`), `${id} not in Layers`);
  }
  assert.match(layers, /workspaceLayersList/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<main class="app-shell">')), /osmImportBtn|Import OSM XML/);
});

test('drawing controls are vertically anchored over the map and create layer outputs', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('<main class="app-shell">') < html.indexOf('class="map-drawing-toolbar"'));
  assert.ok(html.indexOf('class="map-drawing-toolbar"') < html.indexOf('id="map"'));
  assert.match(read('workspace-ui.css'), /\.map-drawing-toolbar[\s\S]*?flex-direction: column/);
  assert.match(html, /data-tooltip="Point"/);
  assert.doesNotMatch(html.slice(html.indexOf('class="map-drawing-toolbar"'), html.indexOf('id="map"')), /<span>Place mark<\/span>/);
  for (const id of ['addPlaceMarkBtn', 'addPathBtn', 'addPolygonBtn', 'finishDrawingBtn']) assert.match(html, new RegExp(`id="${id}"`));
  const app = read('app.js');
  assert.match(app, /function handleMapDrawingClick/);
  assert.match(app, /function finishDrawing/);
  assert.match(app, /addWorkspaceLayer\(\{[\s\S]*?source: 'NEELVAAN'/);
  assert.match(app, /id: 'osm-history-results'/);
});


test('Map Content stays visible and expandable while analysis tools live in a closable workspace window', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('workspace-tools.css');
  assert.match(html, /id="layersPanel"/);
  assert.match(html, /id="mapContentCollapseBtn"/);
  assert.match(html, /id="workspaceModal"/);
  assert.match(html, /id="addDataPanel"/);
  assert.match(html, /id="geojsonFile"/);
  assert.match(app, /function mountAnalysisPanels/);
  assert.match(app, /workspaceExpandedGroups/);
  assert.match(app, /function exportWorkspaceEntry/);
  assert.match(app, /function initMapContentResize/);
  assert.match(read('workspace-ui.css'), /width: min\(1240px, 91vw\)/);
  assert.match(css, /\.sidebar-resizer/);
  assert.match(css, /\.workspace-layer-subcontent/);
});

test('Google Drive connection uses GIS, a clean Google mark and the least-privilege Drive scope', () => {
  const html = read('index.html');
  const app = read('app.js');
  const config = read('google-config.js');
  assert.match(html, /Login with Google/);
  assert.doesNotMatch(html, /SOON/);
  assert.match(html, /id=\"googleLoginBtn\"/);
  assert.match(html, /accounts\.google\.com\/gsi\/client/);
  assert.match(html, /google-config\.js/);
  assert.match(app, /accounts\.oauth2\.initTokenClient/);
  assert.match(app, /Google sign-in setup is required/);
  assert.doesNotMatch(app, /Google sign-in setup is required[^;]+\), \{ once: true \}/);
  assert.match(app, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  assert.match(app, /openid email profile/);
  assert.match(config, /googleClientId: ''/);
});

test('place search is compact and submits on Enter without a visible Search button', () => {
  const html = read('index.html');
  const app = read('app.js');
  const formStart = html.indexOf('id="placeSearchForm"');
  const formEnd = html.indexOf('</form>', formStart);
  const searchForm = html.slice(formStart, formEnd);
  assert.match(searchForm, /id="placeSearchInput"/);
  assert.match(searchForm, /enterkeyhint="search"/);
  assert.doesNotMatch(searchForm, /<button/);
  assert.match(app, /id/); // The handler is attached to the actual form below.
  assert.match(app, /\$\('placeSearchForm'\)\.addEventListener\('submit'/);
  assert.match(app, /searchPlaceOrCoordinates\(\$\('placeSearchInput'\)\.value\)/);
  assert.doesNotMatch(html, /id="placeSearchBtn"|>Search</);
});

test('each basemap is kept as its own ordered Map Content layer and can be made transparent', () => {
  const app = read('app.js');
  assert.match(app, /let basemapSequence = 0/);
  assert.match(app, /basemapSequence \+= 1/);
  assert.match(app, /createStableId\(`basemap-\$\{name\}-\$\{basemapSequence\}`\)/);
  assert.match(app, /metadata: \{ kind: 'basemap', basemapId: name, tileUrl: config\.url \}/);
  assert.doesNotMatch(app.slice(app.indexOf('function setBasemap'), app.indexOf('function renderBasemapGallery')), /removeLayer\(state\.tileLayer\)/);
  assert.match(app, /action\('Transparency', \(\) => openLayerEditDialog\(entry, false, true\)\)/);
  assert.match(read('index.html'), /id="layerEditOpacity"/);
  assert.match(read('index.html'), /id="layerEditNameField"/);
});

test('Line and Polygon save through the shared feature and layer editor', () => {
  const html = read('index.html');
  const app = read('app.js');
  for (const id of ['geometryDialog', 'geometryForm', 'geometryLayerSelect', 'geometryLayerName', 'geometryFeatureName', 'geometryDescription', 'geometryColor']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function openGeometryDialog/);
  assert.match(app, /function saveGeometryFeature/);
  assert.match(app, /type: 'Drawings'/);
  assert.match(app, /featureMode === 'polygon' \|\| featureMode === 'area'/);
});

test('Measure opens a compact options panel with distance, area, units and controls', () => {
  const html = read('index.html');
  const app = read('app.js');
  const mapArea = html.slice(html.indexOf('<section aria-label=\"Map workspace\"'), html.indexOf('</main>'));
  assert.match(mapArea, /id=\"measurePanel\"/, 'Measure panel is positioned inside the map area');
  for (const id of ['measurePanel', 'measureModeSelect', 'measureUnitSelect', 'measureDistanceOutput', 'measureAreaOutput', 'startMeasureBtn', 'clearMeasureBtn', 'finishMeasureBtn', 'cancelMeasureBtn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function openMeasurePanel/);
  assert.match(app, /window\.innerWidth <= 420 && mapContentExpanded/);
  assert.match(app, /measureAutoCollapsedMapContent/);
  assert.match(app, /function updateMeasureReadout/);
  assert.match(app, /function formatMeasuredDistance/);
  assert.match(app, /function formatMeasuredArea/);
  assert.match(read('site-final.css'), /width: min\(286px, calc\(100% - 84px\)\)/);
});

test('footer elevation refreshes when the map is touched, panned or zoomed and remains visible on mobile', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /id="footerElevation"/);
  assert.match(app, /state\.map\.on\('click', event => \{ updateFooterPosition\(event\.latlng\)/);
  assert.match(app, /state\.map\.on\('moveend zoomend', \(\) => \{ updateCameraReadout\(\); updateFooterPosition\(state\.map\.getCenter\(\)\); \}\)/);
  assert.match(app, /api\.open-meteo\.com\/v1\/elevation/);
  assert.match(read('site-final.css'), /\.map-footer-metrics \{ flex: 1 1 100%; min-width: 0; flex-wrap: wrap/);
});

test('site-wide typography and map icons have no glow or drop-shadow treatment', () => {
  const css = read('site-final.css');
  assert.match(css, /\*, \*::before, \*::after \{ text-shadow: none !important; \}/);
  assert.match(css, /\.map-draw-tool svg, \.map-tools svg[\s\S]*?filter: none !important/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
});

test('map redraw keeps the generated workspace layers visible', () => {
  const app = read('app.js');
  assert.match(app, /const managedLayers = new Set\(\[\.\.\.workspaceLayerEntries\.values\(\)\]\.map\(entry => entry\.layer\)\)/);
  assert.match(app, /workspaceLayerEntries\.forEach\(entry => \{/);
  assert.match(app, /historyGroup\.addLayer\(layer\)/);
});



test('Map Content action menu exposes zoom, rename, edit and remove through a viewport-level portal', () => {
  const app = read('app.js');
  assert.match(app, /action\('Zoom to layer'/);
  assert.match(app, /action\('Rename layer'/);
  assert.match(app, /action\('Edit layer'/);
  assert.match(app, /action\('Remove layer'/);
  assert.match(app, /document\.body\.append\(menu\)/);
  assert.match(app, /function positionWorkspaceLayerMenu/);
  assert.match(app, /function openLayerEditDialog/);
  assert.match(read('workspace-polish.css'), /\.workspace-layer-menu\[data-portal="true"\]/);
});

test('Place Mark opens a complete editor with free icons and editable coordinates', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('workspace-polish.css');
  for (const id of ['placeMarkDialog', 'placeMarkForm', 'placeMarkName', 'placeMarkDescription', 'placeMarkIconPicker', 'placeMarkLatitude', 'placeMarkLongitude', 'savePlaceMarkBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(app, /function openPlaceMarkDialog/);
  assert.match(app, /function savePlaceMark/);
  assert.match(app, /record\.layer\.setLatLng\(\[lat, lng\]\)/);
  assert.match(app, /PLACE_MARK_ICONS = \[/);
  assert.match(css, /\.map-draw-tool svg \{ display: block;[^}]*margin: auto/);
  assert.match(css, /\.place-icon-grid/);
});

test('single Map Content heading and one-line footer alignment are in place', () => {
  const html = read('index.html');
  const panel = html.slice(html.indexOf('id="layersPanel"'), html.indexOf('id="osmPanel"'));
  assert.equal((panel.match(/>Map Content</g) || []).length, 1);
  assert.doesNotMatch(panel, /Layers · top to bottom/);
  assert.match(read('workspace-polish.css'), /\.map-footer-left/);
  assert.match(read('workspace-polish.css'), /flex-wrap: nowrap/);
  assert.doesNotMatch(html, /resetNorthBtn|rotationPanel|rotateOptionBtn|rotateBtn/);
  assert.ok(fs.existsSync(path.join(root, 'assets', 'vaanam-earth-texture.webp')));
  assert.doesNotMatch(html, /vaanam-cloud-float/);
});

test('NEELVAAN header contains no secondary spatial-intelligence tagline', () => {
  const html = read('index.html');
  assert.match(html, /<b>NEELVAAN<\/b>/);
  assert.doesNotMatch(html, /SPATIAL INTELLIGENCE PLATFORM/);
});


test('NEELVAAN right rail has Select, Pan, Point, Line, Polygon and Measure in the requested order', () => {
  const html = read('index.html');
  const rail = html.slice(html.indexOf('class="map-drawing-toolbar"'), html.indexOf('id="map"'));
  const orderedIds = ['arrowToolBtn', 'panToolBtn', 'addPlaceMarkBtn', 'addPathBtn', 'addPolygonBtn', 'measureToolBtn'];
  let previous = -1;
  for (const id of orderedIds) {
    const next = rail.indexOf(`id="${id}"`);
    assert.ok(next > previous, `${id} appears in the requested order`);
    previous = next;
  }
  const polish = read('workspace-polish.css');
  assert.match(polish, /labels appear only on hover\/focus/);
  assert.match(polish, /text-shadow: none !important/);
  assert.doesNotMatch(html, /id="rotateOptionBtn"/);
  assert.match(polish, /\.map-drawing-toolbar\s*\{[\s\S]*?right:\s*15px/);
});

test('place marks have a layer-first selector and browser persistence for grouped locations', () => {
  const html = read('index.html');
  const form = html.slice(html.indexOf('id="placeMarkForm"'), html.indexOf('</form>', html.indexOf('id="placeMarkForm"')));
  assert.ok(form.indexOf('id="placeMarkLayerSelect"') < form.indexOf('id="placeMarkName"'));
  assert.match(form, /id="placeMarkLayerName"/);
  assert.match(read('app.js'), /function getPlaceMarkGroups/);
  assert.match(read('app.js'), /function persistPlaceMarkGroups/);
  assert.match(read('app.js'), /function loadPlaceMarkGroups/);
  assert.match(read('app.js'), /PLACE_MARK_STORAGE_KEY = 'neelvaan:place-mark-layers:v1'/);
  assert.match(read('app.js'), /function createPlaceMarkGroup/);
  assert.match(read('app.js'), /function calculatePathDistance/);
  assert.match(read('app.js'), /function setSelectMode/);
});
