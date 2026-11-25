'use strict';

(() => {
  const $ = id => document.getElementById(id);

  const state = {
    versions: [],
    objectId: null,
    objectType: 'way',
    source: 'none',
    activePanel: 'addData',
    uniqueNodeCount: 0,
    memberWayHistories: new Map(),
    searchMarker: null,
    lastGeocodeAt: 0,
    lastTileErrorAt: 0,
    activeDrag: '',
    histories: new Map(),
    analyses: new Map(),
    layers: new Map(),
    selected: null,
    showPoints: true,
    showAreaOverlay: false,
    generation: 0,
    collapsedYears: new Set(),
    layerOrder: new Map(),
    yearOrder: [],
    basemap: 'imagery',
    measureType: 'distance',
    pendingDrawing: null,
    toastTimer: null,
    map: null,
    tileLayer: null,
    drawing: null,
    activeMapTool: 'pan',
    drawingSequence: 0,
    workspaceExpandedGroups: new Set()
  };

  const workspaceLayerEntries = new Map();
  const placeMarkRecords = new Map();
  const PLACE_MARK_STORAGE_KEY = 'neelvaan:place-mark-layers:v1';
  const PLACE_MARK_ICONS = [
    ['📍', 'Pin'], ['⭐', 'Star'], ['❤️', 'Favourite'], ['🏠', 'Home'], ['🏢', 'Office'],
    ['🏫', 'School'], ['🏥', 'Hospital'], ['🏛️', 'Government'], ['🛍️', 'Shopping'], ['🍽️', 'Restaurant'],
    ['☕', 'Cafe'], ['⛽', 'Fuel'], ['🅿️', 'Parking'], ['🚌', 'Bus stop'], ['🚉', 'Rail station'],
    ['✈️', 'Airport'], ['⚓', 'Port'], ['🌳', 'Park'], ['💧', 'Water'], ['⛰️', 'Mountain'],
    ['📷', 'Photo spot'], ['🏖️', 'Beach'], ['🏕️', 'Camp'], ['🏨', 'Hotel'], ['🏦', 'Bank'],
    ['🚓', 'Police'], ['🚒', 'Fire station'], ['💊', 'Pharmacy'], ['⛪', 'Church'], ['🕌', 'Mosque'],
    ['🛕', 'Temple'], ['🏰', 'Landmark'], ['🏟️', 'Stadium'], ['🎓', 'University'], ['ℹ️', 'Information'],
    ['🚩', 'Flag'], ['🎯', 'Target'], ['♿', 'Accessibility'], ['🚻', 'Restroom'], ['🔧', 'Service']
  ];
  let activePlaceMarkIcon = '📍';
  let activePlaceMarkEditId = '';
  let activeLayerEditId = '';
  let dialogReturnFocus = null;
  let workspaceLayerOrder = [];
  let draggingWorkspaceLayer = '';

  const API = 'https://api.openstreetmap.org/api/0.6';
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const MAX_UNIQUE_NODES = 12000;
  const MAX_VERSIONS = 2000;
  const CONCURRENCY = 4;
  let placeSearchGeneration = 0;
  let objectLookupGeneration = 0;
  let elevationTimer = null;
  let currentElevationKey = '';
  const elevationCache = new Map();
  const elevationRequests = new Set();
  let requestedRestoreVersion = null;
  let mapContentExpanded = true;
  let measureAutoCollapsedMapContent = false;
  let basemapSequence = 0;
  let googleDriveAccessToken = '';
  let googleDriveTokenExpiry = 0;
  let googleDriveTokenClient = null;

  async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds. Please retry.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function updateCameraReadout() {
    if (!state.map) return;
    const center = state.map.getCenter();
    const size = state.map.getSize();
    const zoom = state.map.getZoom();
    const metresPerPixel = 156543.03392 * Math.cos(center.lat * Math.PI / 180) / (2 ** zoom);
    const verticalFieldOfView = 45 * Math.PI / 180;
    const cameraMetres = metresPerPixel * Math.max(1, size.y) / (2 * Math.tan(verticalFieldOfView / 2));
    const cameraLabel = cameraMetres >= 1000
      ? `${Math.round(cameraMetres / 1000).toLocaleString()} km`
      : `${Math.round(cameraMetres).toLocaleString()} m`;
    $('footerCamera').textContent = cameraLabel;
  }

  function updateElevationReadout(lat, lon) {
    const gridLat = Number(lat.toFixed(3));
    const gridLon = Number(lon.toFixed(3));
    const key = `${gridLat.toFixed(3)},${gridLon.toFixed(3)}`;
    if (currentElevationKey === key && (elevationCache.has(key) || elevationRequests.has(key))) return;
    currentElevationKey = key;
    $('footerElevation').textContent = elevationCache.has(key)
      ? `${Math.round(elevationCache.get(key)).toLocaleString()} m`
      : 'Loading…';
    if (elevationCache.has(key) || elevationRequests.has(key)) return;

    clearTimeout(elevationTimer);
    elevationTimer = setTimeout(async () => {
      elevationRequests.add(key);
      try {
        const params = new URLSearchParams({ latitude: gridLat.toFixed(3), longitude: gridLon.toFixed(3) });
        const response = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?${params}`, {}, 12000);
        if (!response.ok) throw new Error(`Elevation service returned ${response.status}`);
        const result = await response.json();
        const elevation = Number(result.elevation?.[0]);
        if (!Number.isFinite(elevation)) throw new Error('Elevation was not returned');
        elevationCache.set(key, elevation);
        if (elevationCache.size > 512) elevationCache.delete(elevationCache.keys().next().value);
        if (currentElevationKey === key) {
          $('footerElevation').textContent = `${Math.round(elevation).toLocaleString()} m`;
          $('footerElevation').title = 'Approximate terrain elevation from Copernicus DEM GLO-90, about 90 m resolution.';
        }
      } catch (_) {
        if (currentElevationKey === key) {
          $('footerElevation').textContent = 'Unavailable';
          $('footerElevation').title = 'Terrain elevation is temporarily unavailable. Source: Copernicus DEM GLO-90 via Open-Meteo. Move the map or retry later.';
        }
      } finally {
        elevationRequests.delete(key);
      }
    }, 450);
  }

  function updateFooterPosition(point) {
    if (!point) return;
    const lat = Number(point.lat);
    const lon = Number(point.lng ?? point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    $('footerLatitude').textContent = lat.toFixed(6);
    $('footerLongitude').textContent = lon.toFixed(6);
    updateElevationReadout(lat, lon);
  }

  function updateDrawingToolbar() {
    const drawing = state.drawing;
    const tools = [
      ['arrowToolBtn', 'select'],
      ['panToolBtn', 'pan'],
      ['addPlaceMarkBtn', 'marker'],
      ['addPathBtn', 'path'],
      ['addPolygonBtn', 'polygon'],
      ['measureToolBtn', 'measure']
    ];
    tools.forEach(([id, mode]) => {
      const button = $(id);
      if (!button) return;
      const active = mode === 'select' || mode === 'pan' ? state.activeMapTool === mode : drawing?.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const status = $('drawingStatus');
    const finish = $('finishDrawingBtn');
    const cancel = $('cancelDrawingBtn');
    if (status) {
      status.hidden = !drawing || drawing.mode === 'measure';
      if (drawing) {
        const count = drawing.points.length;
        if (drawing.mode === 'marker') status.textContent = 'Click the map to place a mark.';
        else if (drawing.mode === 'measure') {
          const distance = calculatePathDistance(drawing.points);
          status.textContent = `${count} point${count === 1 ? '' : 's'} · Distance ${formatDistance(distance)}${count >= 3 ? ` · Area ${formatArea(calculatePolygonArea(drawing.points))}` : ''}`;
        } else {
          const modeName = drawing.mode === 'path' ? 'line' : 'polygon';
          const minimum = drawing.mode === 'polygon' ? 3 : 2;
          status.textContent = `${count} point${count === 1 ? '' : 's'} · ${modeName} needs ${minimum}+ points, then Finish.`;
        }
      }
    }
    if (finish) {
      finish.hidden = !drawing || drawing.mode === 'marker' || drawing.mode === 'measure';
      finish.disabled = !drawing || drawing.mode === 'measure' || drawing.points.length < (drawing.mode === 'polygon' ? 3 : 2);
    }
    if (cancel) cancel.hidden = !drawing || drawing.mode === 'measure';
    updateMeasureReadout();
  }

  function cancelDrawing(showMessage = false) {
    const drawing = state.drawing;
    if (drawing?.previewGroup && state.map?.hasLayer(drawing.previewGroup)) {
      state.map.removeLayer(drawing.previewGroup);
    }
    state.drawing = null;
    state.activeMapTool = 'pan';
    if (state.map?.doubleClickZoom) state.map.doubleClickZoom.enable();
    if (state.map?.dragging) state.map.dragging.enable();
    if (state.map?.getContainer()) state.map.getContainer().style.cursor = 'grab';
    updateDrawingToolbar();
    if (showMessage) toast('Drawing cancelled.');
  }

  function setSelectMode() {
    cancelDrawing(false);
    state.activeMapTool = 'select';
    if (state.map?.dragging) state.map.dragging.disable();
    if (state.map?.getContainer()) state.map.getContainer().style.cursor = 'default';
    updateDrawingToolbar();
    toast('Select tool active. Click map features to inspect them.');
  }

  function setPanMode() {
    cancelDrawing(false);
    state.activeMapTool = 'pan';
    if (state.map?.dragging) state.map.dragging.enable();
    if (state.map?.getContainer()) state.map.getContainer().style.cursor = 'grab';
    updateDrawingToolbar();
    toast('Pan tool active. Drag the map to move it.');
  }

  function setDrawingMode(mode) {
    if (!state.map || !['marker', 'path', 'polygon', 'measure'].includes(mode)) return;
    cancelDrawing(false);
    state.activeMapTool = mode;
    state.drawing = { mode, points: [], previewGroup: null };
    if (state.map.doubleClickZoom) state.map.doubleClickZoom.disable();
    if (state.map.dragging) state.map.dragging.disable();
    if (state.map.getContainer()) state.map.getContainer().style.cursor = 'crosshair';
    updateDrawingToolbar();
    const prompts = {
      marker: 'Click the map to place a mark.',
      path: 'Click the map to add path points, then select Finish.',
      polygon: 'Click the map to add polygon corners, then select Finish.',
      measure: 'Use the Measure window to choose units and finish the measurement.'
    };
    toast(prompts[mode]);
  }

  function calculatePathDistance(points) {
    return points.slice(1).reduce((sum, point, index) => sum + points[index].distanceTo(point), 0);
  }

  function calculatePolygonArea(points) {
    if (points.length < 3) return 0;
    const radius = 6378137;
    let total = 0;
    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      const lat1 = current.lat * Math.PI / 180;
      const lat2 = next.lat * Math.PI / 180;
      const deltaLon = (next.lng - current.lng) * Math.PI / 180;
      total += deltaLon * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    return Math.abs(total * radius * radius / 2);
  }

  function formatDistance(metres) {
    return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
  }

  function formatArea(squareMetres) {
    return squareMetres >= 1000000 ? `${(squareMetres / 1000000).toFixed(2)} km²` : `${Math.round(squareMetres).toLocaleString()} m²`;
  }

  function updateDrawingPreview() {
    const drawing = state.drawing;
    if (!drawing || !state.map) return;
    if (!drawing.previewGroup) drawing.previewGroup = L.featureGroup().addTo(state.map);
    drawing.previewGroup.clearLayers();

    if (drawing.points.length >= 2) {
      const wantsArea = drawing.mode === 'polygon' || (drawing.mode === 'measure' && state.measureType === 'area');
      const preview = wantsArea && drawing.points.length >= 3
        ? L.polygon(drawing.points, { color: '#d9b08c', weight: 2.2, fillColor: '#d9b08c', fillOpacity: .12, dashArray: '5 4' })
        : L.polyline(drawing.points, { color: '#d9b08c', weight: 2.2, dashArray: '5 4' });
      drawing.previewGroup.addLayer(preview);
    }
    drawing.points.forEach(point => {
      drawing.previewGroup.addLayer(L.circleMarker(point, { radius: 4, color: '#202825', weight: 2, fillColor: '#d9b08c', fillOpacity: 1 }));
    });
  }

  function nextDrawingName(mode) {
    state.drawingSequence += 1;
    const names = { marker: 'Place mark', path: 'Line', polygon: 'Polygon', measure: 'Measurement' };
    return `${names[mode]} ${state.drawingSequence}`;
  }

  function createPlaceMarkerIcon(symbol) {
    const safeSymbol = escapeHTML(symbol || '📍');
    return L.divIcon({
      className: 'place-mark-div-icon',
      html: `<span class="place-mark-map-icon" aria-hidden="true">${safeSymbol}</span>`,
      iconSize: [38, 42],
      iconAnchor: [19, 39],
      popupAnchor: [0, -36]
    });
  }

  function placeMarkerPopupContent(metadata, recordId) {
    const lat = Number(metadata.lat);
    const lon = Number(metadata.lng);
    const description = metadata.description
      ? `<p>${escapeHTML(metadata.description).replace(/\n/g, '<br>')}</p>`
      : '';
    return `<div class="place-marker-popup"><strong>${escapeHTML(metadata.name || 'Place mark')}</strong>${description}<small>${lat.toFixed(6)}, ${lon.toFixed(6)}</small><button type="button" class="place-marker-edit" data-place-mark-edit="${escapeHTML(recordId)}">Edit place</button></div>`;
  }

  function createStableId(prefix) {
    const token = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    return `${prefix}-${token}`;
  }

  function getPlaceMarkGroups() {
    return [...workspaceLayerEntries.values()].filter(entry => entry.metadata?.kind === 'place-mark-group');
  }

  function syncPlaceMarkLayerPicker(selectedId = '__new__') {
    const select = $('placeMarkLayerSelect');
    if (!select) return;
    select.replaceChildren();
    const newOption = document.createElement('option');
    newOption.value = '__new__';
    newOption.textContent = 'Create new layer…';
    select.append(newOption);
    getPlaceMarkGroups().forEach(group => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      select.append(option);
    });
    select.value = [...select.options].some(option => option.value === selectedId) ? selectedId : '__new__';
    updatePlaceMarkLayerNameField();
  }

  function updatePlaceMarkLayerNameField() {
    const select = $('placeMarkLayerSelect');
    const wrap = $('placeMarkNewLayerWrap');
    const input = $('placeMarkLayerName');
    if (!select || !wrap || !input) return;
    const isNew = select.value === '__new__';
    wrap.hidden = !isNew;
    input.required = isNew;
    if (isNew && !input.value.trim()) input.value = 'Places';
  }

  function persistPlaceMarkGroups() {
    try {
      const data = getPlaceMarkGroups().map(group => ({
        id: group.id,
        name: group.name,
        marks: (group.metadata?.placeMarks || []).map(mark => ({
          id: mark.id,
          name: mark.name,
          description: mark.description || '',
          icon: mark.icon || '📍',
          lat: Number(mark.lat),
          lng: Number(mark.lng)
        }))
      }));
      localStorage.setItem(PLACE_MARK_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.warn('NEELVAAN could not save place marks in this browser.', error);
      toast('Place marks are in memory, but browser storage is unavailable. Export the layer to keep a copy.');
    }
  }

  function createPlaceMarkMarker(groupEntry, mark) {
    const metadata = { ...mark, kind: 'place-mark' };
    const marker = L.marker([Number(mark.lat), Number(mark.lng)], {
      icon: createPlaceMarkerIcon(mark.icon || '📍'),
      title: mark.name
    }).bindPopup(placeMarkerPopupContent(metadata, mark.id));
    marker.feature = { type: 'Feature', properties: { id: mark.id, name: mark.name, description: mark.description || '', icon: mark.icon || '📍', layerName: groupEntry.name, featureType: 'place-mark' } };
    const record = { ...metadata, id: mark.id, groupId: groupEntry.id, layer: marker, metadata };
    placeMarkRecords.set(mark.id, record);
    marker.on('popupopen', event => {
      const editButton = event.popup.getElement()?.querySelector('[data-place-mark-edit]');
      editButton?.addEventListener('click', () => openPlaceMarkDialog(marker.getLatLng(), record), { once: true });
    });
    groupEntry.layer.addLayer(marker);
    return record;
  }

  function createPlaceMarkGroup(name) {
    const id = createStableId('place-mark-layer');
    return addWorkspaceLayer({
      id,
      name,
      type: 'Place marks',
      source: 'User',
      metadata: { kind: 'place-mark-group', placeMarks: [] },
      layer: L.featureGroup()
    });
  }

  function loadPlaceMarkGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem(PLACE_MARK_STORAGE_KEY) || '[]');
      if (!Array.isArray(saved)) return;
      saved.forEach(groupData => {
        if (!groupData || !Array.isArray(groupData.marks)) return;
        const group = addWorkspaceLayer({
          id: String(groupData.id || createStableId('place-mark-layer')),
          name: String(groupData.name || 'Places'),
          type: 'Place marks',
          source: 'User',
          metadata: { kind: 'place-mark-group', placeMarks: [] },
          layer: L.featureGroup()
        });
        groupData.marks.forEach(mark => {
          const lat = Number(mark.lat);
          const lng = Number(mark.lng);
          if (!mark.id || !mark.name || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return;
          const cleanMark = { id: String(mark.id), name: String(mark.name), description: String(mark.description || ''), icon: String(mark.icon || '📍'), lat, lng };
          group.metadata.placeMarks.push(cleanMark);
          createPlaceMarkMarker(group, cleanMark);
        });
      });
    } catch (error) {
      console.warn('NEELVAAN place-mark browser data could not be restored.', error);
    }
  }

  function commitUserDrawing(mode, layer, details = {}) {
    const defaultName = nextDrawingName(mode);
    const name = String(details.name || defaultName).trim();
    const typeNames = { marker: 'Place mark', path: 'Line', polygon: 'Polygon', arrow: 'Arrow', measure: 'Measurement' };
    addWorkspaceLayer({
      id: createStableId(`user-${mode}`),
      name,
      type: typeNames[mode] || 'Map feature',
      source: 'NEELVAAN',
      metadata: details.metadata || null,
      layer
    });
    cancelDrawing(false);
    if (mode === 'measure') closeMeasurePanel(false);
    toast(`${name} added to Map Content.`);
  }

  function getGeometryGroups() {
    return [...workspaceLayerEntries.values()].filter(entry => entry.metadata?.kind === 'geometry-group');
  }

  function createGeometryGroup(name) {
    return addWorkspaceLayer({
      id: createStableId('drawing-layer'),
      name,
      type: 'Drawings',
      source: 'User',
      metadata: { kind: 'geometry-group', features: [] },
      layer: L.featureGroup()
    });
  }

  function syncGeometryLayerPicker(selectedId = '__new__') {
    const select = $('geometryLayerSelect');
    if (!select) return;
    select.replaceChildren();
    const newOption = document.createElement('option');
    newOption.value = '__new__';
    newOption.textContent = 'Create new layer…';
    select.append(newOption);
    getGeometryGroups().forEach(group => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      select.append(option);
    });
    select.value = [...select.options].some(option => option.value === selectedId) ? selectedId : '__new__';
    updateGeometryLayerNameField();
  }

  function updateGeometryLayerNameField() {
    const isNew = $('geometryLayerSelect').value === '__new__';
    $('geometryNewLayerWrap').hidden = !isNew;
    $('geometryLayerName').required = isNew;
  }

  function openGeometryDialog(drawing) {
    if (!drawing) return;
    state.pendingDrawing = drawing;
    const isPolygon = drawing.mode === 'polygon';
    $('geometryDialogTitle').textContent = isPolygon ? 'Save polygon' : 'Save line';
    $('geometryDialogHint').textContent = 'Choose a layer, name this feature and set its display colour.';
    $('geometryFeatureName').value = nextDrawingName(drawing.mode);
    $('geometryDescription').value = '';
    $('geometryColor').value = '#d9b08c';
    $('geometryMetrics').textContent = isPolygon
      ? `Area: ${formatArea(calculatePolygonArea(drawing.points))} · ${drawing.points.length} vertices`
      : `Length: ${formatDistance(calculatePathDistance(drawing.points))} · ${drawing.points.length} vertices`;
    $('geometryFormError').hidden = true;
    syncGeometryLayerPicker();
    $('geometryDialog').hidden = false;
    $('geometryDialog').setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => $('geometryFeatureName').focus());
  }

  function closeGeometryDialog(cancelPending = true) {
    const dialog = $('geometryDialog');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    state.pendingDrawing = null;
    if (cancelPending && state.drawing) cancelDrawing(false);
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  }

  function saveGeometryFeature(event) {
    event.preventDefault();
    const drawing = state.pendingDrawing;
    const error = $('geometryFormError');
    if (!drawing || !state.drawing) {
      error.textContent = 'This drawing is no longer available. Draw it again.';
      error.hidden = false;
      return;
    }
    const name = $('geometryFeatureName').value.trim();
    const description = $('geometryDescription').value.trim();
    const color = $('geometryColor').value || '#d9b08c';
    if (!name) {
      error.textContent = 'Enter a name for this drawing.';
      error.hidden = false;
      $('geometryFeatureName').focus();
      return;
    }
    const selectedId = $('geometryLayerSelect').value;
    let group = selectedId === '__new__' ? null : workspaceLayerEntries.get(selectedId);
    if (selectedId !== '__new__' && (!group || group.metadata?.kind !== 'geometry-group')) {
      error.textContent = 'Select a valid drawing layer or create a new one.';
      error.hidden = false;
      return;
    }
    if (!group) {
      const layerName = $('geometryLayerName').value.trim();
      if (!layerName) {
        error.textContent = 'Enter a layer name before saving this drawing.';
        error.hidden = false;
        $('geometryLayerName').focus();
        return;
      }
      group = createGeometryGroup(layerName);
    }
    let featureLayer;
    let metrics = '';
    if (drawing.mode === 'polygon') {
      const area = calculatePolygonArea(drawing.points);
      featureLayer = L.polygon(drawing.points, { color, weight: 2.4, fillColor: color, fillOpacity: .16 });
      metrics = `Area: ${formatArea(area)}`;
    } else {
      const length = calculatePathDistance(drawing.points);
      featureLayer = L.polyline(drawing.points, { color, weight: 3 });
      metrics = `Length: ${formatDistance(length)}`;
    }
    const coords = drawing.points.map(point => `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`).join(' · ');
    const descriptionHtml = description ? `<p>${escapeHTML(description)}</p>` : '';
    featureLayer.bindPopup(`<div class="drawing-feature-popup"><strong>${escapeHTML(name)}</strong>${descriptionHtml}<small>${metrics}</small><code>${escapeHTML(coords)}</code></div>`);
    featureLayer.feature = { type: 'Feature', properties: { name, description, featureType: drawing.mode, layerName: group.name, color, metrics }, geometry: featureLayer.toGeoJSON().geometry };
    group.metadata.features ||= [];
    group.metadata.features.push({ name, description, featureType: drawing.mode, color, metrics });
    group.layer.addLayer(featureLayer);
    renderWorkspaceLayers();
    closeGeometryDialog(false);
    cancelDrawing(false);
    toast(`${name} added to ${group.name}.`);
    featureLayer.openPopup();
  }

  function renderPlaceMarkIconPicker(selected = '📍') {
    const host = $('placeMarkIconPicker');
    if (!host) return;
    host.replaceChildren();
    PLACE_MARK_ICONS.forEach(([symbol, label]) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'place-icon-option';
      option.textContent = symbol;
      option.title = label;
      option.setAttribute('aria-label', label);
      option.setAttribute('aria-pressed', String(symbol === selected));
      option.classList.toggle('selected', symbol === selected);
      option.addEventListener('click', () => {
        activePlaceMarkIcon = symbol;
        host.querySelectorAll('.place-icon-option').forEach(button => {
          const active = button.textContent === symbol;
          button.classList.toggle('selected', active);
          button.setAttribute('aria-pressed', String(active));
        });
      });
      host.append(option);
    });
  }

  function openPlaceMarkDialog(point, entry = null) {
    const dialog = $('placeMarkDialog');
    if (!dialog) return;
    dialogReturnFocus = document.activeElement;
    activePlaceMarkEditId = entry?.id || '';
    const current = entry?.layer?.getLatLng?.() || point;
    if (!current) return;
    const metadata = entry?.metadata || {};
    const name = entry?.name || '';
    $('placeMarkDialogTitle').textContent = entry ? 'Edit place mark' : 'Add place mark';
    $('placeMarkDialogHint').textContent = entry
      ? 'Update its layer, name, description, icon or coordinates.'
      : 'Choose a layer first. Add this place to an existing layer or create a new one.';
    $('savePlaceMarkBtn').textContent = entry ? 'Save changes' : 'Save place';
    syncPlaceMarkLayerPicker(entry?.groupId || '__new__');
    $('placeMarkLayerSelect').disabled = Boolean(entry);
    $('placeMarkLayerName').value = entry ? (workspaceLayerEntries.get(entry.groupId)?.name || '') : 'Places';
    $('placeMarkName').value = name;
    $('placeMarkDescription').value = metadata.description || '';
    $('placeMarkLatitude').value = Number(current.lat).toFixed(6);
    $('placeMarkLongitude').value = Number(current.lng).toFixed(6);
    $('placeMarkFormError').hidden = true;
    activePlaceMarkIcon = metadata.icon || '📍';
    renderPlaceMarkIconPicker(activePlaceMarkIcon);
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => $('placeMarkName').focus());
  }

  function closePlaceMarkDialog() {
    const dialog = $('placeMarkDialog');
    if (!dialog || dialog.hidden) return;
    const wasCreating = !activePlaceMarkEditId;
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    activePlaceMarkEditId = '';
    $('placeMarkLayerSelect').disabled = false;
    if (wasCreating && state.drawing?.mode === 'marker') cancelDrawing(false);
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  }

  function savePlaceMark(event) {
    event.preventDefault();
    const name = $('placeMarkName').value.trim();
    const description = $('placeMarkDescription').value.trim();
    const lat = Number($('placeMarkLatitude').value);
    const lng = Number($('placeMarkLongitude').value);
    const error = $('placeMarkFormError');
    if (!name) {
      error.textContent = 'Enter a place name.';
      error.hidden = false;
      $('placeMarkName').focus();
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      error.textContent = 'Enter valid coordinates: latitude −90 to 90 and longitude −180 to 180.';
      error.hidden = false;
      return;
    }

    const metadata = { kind: 'place-mark', name, description, icon: activePlaceMarkIcon, lat, lng };
    if (activePlaceMarkEditId) {
      const record = placeMarkRecords.get(activePlaceMarkEditId);
      if (!record) {
        error.textContent = 'This place mark is no longer available.';
        error.hidden = false;
        return;
      }
      record.name = name;
      record.description = description;
      record.icon = activePlaceMarkIcon;
      record.lat = lat;
      record.lng = lng;
      record.metadata = metadata;
      record.layer.setLatLng([lat, lng]);
      record.layer.setIcon(createPlaceMarkerIcon(activePlaceMarkIcon));
      record.layer.options.title = name;
      if (record.layer.feature?.properties) Object.assign(record.layer.feature.properties, { name, description, icon: activePlaceMarkIcon });
      record.layer.bindPopup(placeMarkerPopupContent(metadata, record.id));
      const group = workspaceLayerEntries.get(record.groupId);
      if (group) {
        const savedMark = (group.metadata.placeMarks || []).find(mark => mark.id === record.id);
        if (savedMark) Object.assign(savedMark, { name, description, icon: activePlaceMarkIcon, lat, lng });
        if (record.layer.feature?.properties) record.layer.feature.properties.layerName = group.name;
      }
      persistPlaceMarkGroups();
      renderWorkspaceLayers();
      closePlaceMarkDialog();
      toast(`${name} updated.`);
      return;
    }

    const selectedLayerId = $('placeMarkLayerSelect').value;
    let group = selectedLayerId === '__new__' ? null : workspaceLayerEntries.get(selectedLayerId);
    if (selectedLayerId !== '__new__' && (!group || group.metadata?.kind !== 'place-mark-group')) {
      error.textContent = 'Select a valid existing place-mark layer, or create a new one.';
      error.hidden = false;
      return;
    }
    if (!group) {
      const layerName = $('placeMarkLayerName').value.trim();
      if (!layerName) {
        error.textContent = 'Enter a layer name before saving the place.';
        error.hidden = false;
        $('placeMarkLayerName').focus();
        return;
      }
      group = createPlaceMarkGroup(layerName);
    }
    const mark = { id: createStableId('place-mark'), name, description, icon: activePlaceMarkIcon, lat, lng };
    group.metadata.placeMarks ||= [];
    group.metadata.placeMarks.push(mark);
    createPlaceMarkMarker(group, mark);
    persistPlaceMarkGroups();
    renderWorkspaceLayers();
    closePlaceMarkDialog();
    const savedLayerName = group.name;
    toast(`${name} added to ${savedLayerName}.`);
    placeMarkRecords.get(mark.id)?.layer.openPopup();
  }

  function handleMapDrawingClick(event) {
    const drawing = state.drawing;
    if (!drawing || !event?.latlng) return;
    if (drawing.mode === 'marker') {
      openPlaceMarkDialog(event.latlng);
      return;
    }
    drawing.points.push(event.latlng);
    updateDrawingPreview();
    updateDrawingToolbar();
  }

  function formatMeasuredDistance(metres, unit) {
    if (!Number.isFinite(metres)) return '—';
    if (unit === 'imperial') return metres >= 1609.344 ? `${(metres / 1609.344).toFixed(2)} mi` : `${(metres * 3.28084).toFixed(0)} ft`;
    if (unit === 'metric') return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(1)} m`;
    return formatDistance(metres);
  }

  function formatMeasuredArea(squareMetres, unit) {
    if (!Number.isFinite(squareMetres)) return '—';
    if (unit === 'imperial') return squareMetres >= 4046.856 ? `${(squareMetres / 4046.856).toFixed(2)} acres` : `${(squareMetres * 10.7639).toFixed(0)} ft²`;
    if (unit === 'metric') {
      if (squareMetres >= 1000000) return `${(squareMetres / 1000000).toFixed(2)} km²`;
      if (squareMetres >= 10000) return `${(squareMetres / 10000).toFixed(2)} ha`;
      return `${Math.round(squareMetres).toLocaleString()} m²`;
    }
    return formatArea(squareMetres);
  }

  function updateMeasureReadout() {
    const panel = $('measurePanel');
    if (!panel) return;
    const points = state.drawing?.mode === 'measure' ? state.drawing.points : [];
    const distance = points.length >= 2 ? calculatePathDistance(points) : 0;
    const area = points.length >= 3 ? calculatePolygonArea(points) : 0;
    const unit = $('measureUnitSelect')?.value || 'auto';
    $('measureDistanceOutput').textContent = points.length >= 2 ? formatMeasuredDistance(distance, unit) : '—';
    $('measureAreaOutput').textContent = points.length >= 3 ? formatMeasuredArea(area, unit) : '—';
    const active = state.drawing?.mode === 'measure';
    $('startMeasureBtn').textContent = active ? 'Measuring…' : 'Start measuring';
    $('startMeasureBtn').disabled = active;
    $('clearMeasureBtn').disabled = !active || points.length === 0;
    const minimum = state.measureType === 'area' ? 3 : 2;
    $('finishMeasureBtn').disabled = !active || points.length < minimum;
    $('measureHelp').textContent = active
      ? (state.measureType === 'area' ? 'Tap or click at least 3 corners on the map, then Finish.' : 'Tap or click at least 2 points on the map, then Finish.')
      : 'Choose Distance or Area, select units, then start measuring on the map.';
  }

  function closeMeasurePanel(cancelActive = true) {
    const panel = $('measurePanel');
    if (!panel) return;
    panel.hidden = true;
    if (cancelActive && state.drawing?.mode === 'measure') cancelDrawing(false);
    if (measureAutoCollapsedMapContent) {
      measureAutoCollapsedMapContent = false;
      setMapContentExpanded(true);
    }
    updateMeasureReadout();
  }

  function openMeasurePanel() {
    $('measurePanel').hidden = false;
    state.measureType = $('measureModeSelect').value || 'distance';
    if (window.innerWidth <= 420 && mapContentExpanded) {
      measureAutoCollapsedMapContent = true;
      setMapContentExpanded(false);
    }
    updateMeasureReadout();
  }

  function startMeasurement() {
    state.measureType = $('measureModeSelect').value || 'distance';
    setDrawingMode('measure');
    updateMeasureReadout();
  }

  function clearMeasurementPoints() {
    if (state.drawing?.mode !== 'measure') return;
    state.drawing.points = [];
    state.drawing.previewGroup?.clearLayers();
    updateDrawingToolbar();
  }

  function finishDrawing() {
    const drawing = state.drawing;
    if (!drawing || drawing.mode === 'marker') return;
    const isMeasure = drawing.mode === 'measure';
    const featureMode = isMeasure ? state.measureType : drawing.mode;
    const minimum = featureMode === 'polygon' || featureMode === 'area' ? 3 : 2;
    if (drawing.points.length < minimum) {
      toast(`Add at least ${minimum} points before finishing.`);
      return;
    }
    const points = drawing.points.slice();
    if (!isMeasure) {
      openGeometryDialog({ mode: drawing.mode, points });
      return;
    }
    const distance = calculatePathDistance(points);
    const area = state.measureType === 'area' ? calculatePolygonArea(points) : 0;
    const unit = $('measureUnitSelect').value || 'auto';
    const parts = [`Distance: ${formatMeasuredDistance(distance, unit)}`];
    if (area) parts.push(`Area: ${formatMeasuredArea(area, unit)}`);
    const layer = state.measureType === 'area'
      ? L.polygon(points, { color: '#42a69b', weight: 2.5, fillColor: '#42a69b', fillOpacity: .12 })
      : L.polyline(points, { color: '#42a69b', weight: 2.5, dashArray: '5 4' });
    layer.bindTooltip(parts.join(' · '), { sticky: true });
    const modeLabel = state.measureType === 'area' ? 'Area measurement' : 'Distance measurement';
    const details = {
      name: `${modeLabel} ${state.drawingSequence + 1}`,
      metadata: { kind: 'measurement', measureType: state.measureType, distanceMeters: distance, areaSquareMeters: area, displayUnits: unit, points: points.map(point => [point.lat, point.lng]) }
    };
    commitUserDrawing('measure', layer, details);
  }

  function bindDrawingTools() {
    const toolbar = document.querySelector('.map-drawing-toolbar');
    if (toolbar) L.DomEvent.disableClickPropagation(toolbar);
    $('arrowToolBtn').addEventListener('click', setSelectMode);
    $('panToolBtn').addEventListener('click', setPanMode);
    $('addPlaceMarkBtn').addEventListener('click', () => setDrawingMode('marker'));
    $('addPathBtn').addEventListener('click', () => setDrawingMode('path'));
    $('addPolygonBtn').addEventListener('click', () => setDrawingMode('polygon'));
    $('measureToolBtn').addEventListener('click', openMeasurePanel);
    $('startMeasureBtn').addEventListener('click', startMeasurement);
    $('finishMeasureBtn').addEventListener('click', finishDrawing);
    $('clearMeasureBtn').addEventListener('click', clearMeasurementPoints);
    $('cancelMeasureBtn').addEventListener('click', () => closeMeasurePanel(true));
    $('closeMeasurePanelBtn').addEventListener('click', () => closeMeasurePanel(true));
    $('measureModeSelect').addEventListener('change', () => {
      state.measureType = $('measureModeSelect').value;
      if (state.drawing?.mode === 'measure') clearMeasurementPoints();
      else updateMeasureReadout();
    });
    $('measureUnitSelect').addEventListener('change', updateMeasureReadout);
    $('geometryLayerSelect').addEventListener('change', updateGeometryLayerNameField);
    $('geometryForm').addEventListener('submit', saveGeometryFeature);
    $('geometryDialog').querySelectorAll('[data-geometry-dialog-close]').forEach(button => button.addEventListener('click', () => closeGeometryDialog(true)));
    $('finishDrawingBtn').addEventListener('click', finishDrawing);
    $('cancelDrawingBtn').addEventListener('click', () => cancelDrawing(true));
    $('placeMarkLayerSelect').addEventListener('change', updatePlaceMarkLayerNameField);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('geometryDialog').hidden) { closeGeometryDialog(true); return; }
      if (event.key === 'Escape' && !$('measurePanel').hidden) { closeMeasurePanel(true); return; }
      if (event.key === 'Escape' && state.drawing) cancelDrawing(true);
    });
    updateDrawingToolbar();
  }

  function closeAnalysisDropdown() {
    const menu = $('analysisMenu');
    const trigger = $('analysisMenuBtn');
    if (menu) menu.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('menu-open');
    }
  }

  function initMap() {
    if (!window.L) {
      toast('Map library could not load. Check your internet connection and reload.');
      return;
    }

    state.map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      worldCopyJump: true,
    }).setView([20.5937, 78.9629], 5);

    window.NEELVAANMap = state.map;
    window.NEELVAANLayerManager = { addLayer: addWorkspaceLayer, removeLayer: removeWorkspaceLayer, setVisible: setWorkspaceLayerVisible, render: renderWorkspaceLayers };
    // Compatibility aliases for integrations that used the previous global names.
    window.VAANAMMap = state.map;
    window.VAANAMLayerManager = window.NEELVAANLayerManager;

    const scaleControl = L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 150 }).addTo(state.map);
    $('mapScaleSlot').appendChild(scaleControl.getContainer());
    const attributionControl = L.control.attribution({ position: 'bottomright', prefix: false }).addTo(state.map);
    $('mapAttributionSlot').appendChild(attributionControl.getContainer());

    setBasemap('imagery');
    state.map.on('mousemove', event => updateFooterPosition(event.latlng));
    state.map.on('click', event => { updateFooterPosition(event.latlng); handleMapDrawingClick(event); });
    state.map.on('moveend zoomend', () => { updateCameraReadout(); updateFooterPosition(state.map.getCenter()); });
    state.map.on('resize', updateCameraReadout);
    state.map.on('contextmenu', event => {
      const lat = event.latlng.lat;
      const lon = event.latlng.lng;
      const decimalLabel = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      const popup = L.popup({ closeButton: true, autoClose: true, className: 'coordinate-popup-shell' })
        .setLatLng(event.latlng)
        .setContent(`<div class="coordinate-popup"><span class="coordinate-popup-heading">COORDINATES · DECIMAL DEGREES</span><code>${decimalLabel}</code><button type="button" class="copy-coordinate">Copy coordinates</button></div>`)
        .openOn(state.map);
      setTimeout(() => {
        const button = popup.getElement()?.querySelector('.copy-coordinate');
        if (button) button.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(decimalLabel);
            toast(`Copied ${decimalLabel}`);
            state.map.closePopup(popup);
          } catch (_) { toast('Clipboard access is unavailable here. Copy the decimal coordinates shown above.'); }
        });
      }, 0);
    });

    $('zoomInBtn').addEventListener('click', () => state.map.zoomIn());
    $('zoomOutBtn').addEventListener('click', () => state.map.zoomOut());
    loadPlaceMarkGroups();
    bindDrawingTools();

    updateCameraReadout();
    updateFooterPosition(state.map.getCenter());
  }

  function safePaneId(id) {
    return `vaanam-layer-${String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
  }

  function assignWorkspacePane(layer, paneName) {
    if (!layer) return;
    if (layer.options && typeof layer.options === 'object') layer.options.pane = paneName;
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(child => assignWorkspacePane(child, paneName));
    }
  }

  function prepareWorkspacePane(entry) {
    if (!entry || !state.map) return null;
    entry.paneName ||= safePaneId(entry.id);
    let pane = state.map.getPane(entry.paneName);
    if (!pane) pane = state.map.createPane(entry.paneName);
    assignWorkspacePane(entry.layer, entry.paneName);
    return pane;
  }

  // The list is top-to-bottom. Leaflet panes are assigned bottom-to-top so the
  // first item in Map Content is always the visually highest map layer.
  function applyWorkspaceLayerOrder() {
    if (!state.map) return;
    const bottomToTop = workspaceLayerOrder.slice().reverse();
    const lowestPaneZ = 205;
    const highestPaneZ = 680;
    const paneStep = bottomToTop.length > 1
      ? (highestPaneZ - lowestPaneZ) / (bottomToTop.length - 1)
      : 0;
    bottomToTop.forEach((id, index) => {
      const entry = workspaceLayerEntries.get(id);
      if (!entry) return;
      const pane = prepareWorkspacePane(entry);
      if (!pane) return;
      pane.style.zIndex = String(Math.round(bottomToTop.length === 1 ? 420 : lowestPaneZ + index * paneStep));
      pane.style.pointerEvents = 'none';
    });
  }

  function setWorkspaceLayerVisible(id, visible) {
    const entry = workspaceLayerEntries.get(id);
    if (!entry || !state.map) return;
    entry.visible = Boolean(visible);
    if (entry.visible && !state.map.hasLayer(entry.layer)) {
      prepareWorkspacePane(entry);
      entry.layer.addTo(state.map);
    }
    if (!entry.visible && state.map.hasLayer(entry.layer)) state.map.removeLayer(entry.layer);
    applyWorkspaceLayerOrder();
    renderWorkspaceLayers();
  }

  function removeWorkspaceLayer(id) {
    const entry = workspaceLayerEntries.get(id);
    if (!entry) return;
    if (state.map?.hasLayer(entry.layer)) state.map.removeLayer(entry.layer);
    if (entry.metadata?.kind === 'place-mark-group') {
      (entry.metadata.placeMarks || []).forEach(mark => placeMarkRecords.delete(mark.id));
    }
    workspaceLayerEntries.delete(id);
    workspaceLayerOrder = workspaceLayerOrder.filter(key => key !== id);
    if (entry.metadata?.kind === 'place-mark-group') persistPlaceMarkGroups();
    renderWorkspaceLayers();
  }

  function addWorkspaceLayer(config) {
    if (!config || !config.id || !config.layer || !state.map) return null;
    const id = String(config.id);
    const existing = workspaceLayerEntries.get(id);
    const existingOrderIndex = workspaceLayerOrder.indexOf(id);
    if (existing && state.map.hasLayer(existing.layer)) state.map.removeLayer(existing.layer);
    workspaceLayerEntries.delete(id);
    const entry = {
      id,
      name: String(config.name || existing?.name || 'Untitled layer'),
      type: String(config.type || existing?.type || 'Analysis'),
      source: String(config.source || existing?.source || ''),
      metadata: config.metadata ? { ...config.metadata } : (existing?.metadata ? { ...existing.metadata } : null),
      layer: config.layer,
      visible: typeof config.visible === 'boolean' ? config.visible : (existing?.visible !== false),
      opacity: Number.isFinite(config.opacity) ? Math.max(0, Math.min(1, config.opacity)) : (existing?.opacity ?? 1),
      paneName: existing?.paneName || safePaneId(id)
    };
    workspaceLayerEntries.set(id, entry);
    if (existingOrderIndex < 0) workspaceLayerOrder.unshift(id);
    prepareWorkspacePane(entry);
    applyLayerOpacity(entry);
    if (entry.visible) entry.layer.addTo(state.map);
    applyWorkspaceLayerOrder();
    renderWorkspaceLayers();
    return entry;
  }

  function applyLayerOpacity(entry) {
    if (typeof entry.layer.setOpacity === 'function') entry.layer.setOpacity(entry.opacity);
    else if (typeof entry.layer.setStyle === 'function') {
      entry.layer.setStyle({ opacity: entry.opacity, fillOpacity: Math.min(.85, entry.opacity * .45) });
    } else if (typeof entry.layer.eachLayer === 'function') {
      entry.layer.eachLayer(child => {
        if (typeof child.setOpacity === 'function') child.setOpacity(entry.opacity);
        else if (typeof child.setStyle === 'function') child.setStyle({ opacity: entry.opacity, fillOpacity: Math.min(.85, entry.opacity * .45) });
      });
    }
  }

  function zoomToWorkspaceLayer(entry) {
    if (!entry || !state.map) return;
    if (typeof entry.layer.getLatLng === 'function') {
      state.map.setView(entry.layer.getLatLng(), Math.max(state.map.getZoom(), 16), { animate: true });
      return;
    }
    const bounds = typeof entry.layer.getBounds === 'function' ? entry.layer.getBounds() : null;
    if (bounds?.isValid?.()) state.map.fitBounds(bounds.pad(.08), { maxZoom: 17 });
  }

  function closeWorkspaceLayerMenus() {
    document.querySelectorAll('.workspace-layer-menu[data-portal="true"]').forEach(menu => { menu.hidden = true; });
    document.querySelectorAll('.workspace-layer-menu-button').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function positionWorkspaceLayerMenu(menu, button) {
    menu.hidden = false;
    menu.style.position = 'fixed';
    menu.style.left = 'auto';
    menu.style.right = 'auto';
    menu.style.maxHeight = `${Math.max(120, window.innerHeight - 20)}px`;
    menu.style.overflowY = 'auto';
    const anchor = button.getBoundingClientRect();
    const menuWidth = Math.min(menu.getBoundingClientRect().width || 194, window.innerWidth - 20);
    const menuHeight = Math.min(menu.scrollHeight || 260, window.innerHeight - 20);
    const preferredLeft = anchor.right + 8;
    const fitsBesidePanel = preferredLeft + menuWidth <= window.innerWidth - 10;
    if (fitsBesidePanel) {
      menu.style.left = `${preferredLeft}px`;
    } else {
      menu.style.right = `${Math.max(10, window.innerWidth - anchor.right)}px`;
    }
    const roomAbove = Math.max(0, anchor.top - 10);
    const roomBelow = Math.max(0, window.innerHeight - anchor.bottom - 10);
    const openAbove = roomAbove >= menuHeight || (roomBelow < menuHeight && roomAbove > roomBelow);
    const desiredTop = openAbove ? anchor.top - menuHeight - 6 : anchor.bottom + 6;
    menu.style.top = `${Math.max(10, Math.min(desiredTop, window.innerHeight - menuHeight - 10))}px`;
  }

  function openLayerEditDialog(entry, renameOnly = false, focusOpacity = false) {
    if (!entry) return;
    dialogReturnFocus = document.activeElement;
    activeLayerEditId = entry.id;
    $('layerEditDialogTitle').textContent = focusOpacity ? 'Layer transparency' : (renameOnly ? 'Rename layer' : 'Edit layer');
    $('layerEditNameField')?.classList.toggle('transparency-only', focusOpacity);
    $('layerEditDialog').querySelector('.place-mark-header p').textContent = focusOpacity ? 'Adjust how strongly this map layer is displayed.' : 'Update the layer name and display opacity.';
    $('layerEditName').value = entry.name;
    $('layerEditName').required = !focusOpacity;
    $('layerEditOpacity').value = String(Math.round(entry.opacity * 100));
    $('layerEditOpacityValue').textContent = `${Math.round(entry.opacity * 100)}%`;
    $('layerEditOpacityField').hidden = renameOnly;
    if (focusOpacity) $('layerEditOpacityField').hidden = false;
    $('layerEditFormError').hidden = true;
    const dialog = $('layerEditDialog');
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => (focusOpacity ? $('layerEditOpacity') : $('layerEditName')).focus());
  }

  function closeLayerEditDialog() {
    const dialog = $('layerEditDialog');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    activeLayerEditId = '';
    $('layerEditName').required = true;
    $('layerEditNameField')?.classList.remove('transparency-only');
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  }

  function bindMapFeatureDialogs() {
    renderPlaceMarkIconPicker();
    $('placeMarkForm').addEventListener('submit', savePlaceMark);
    $('placeMarkDialog').querySelectorAll('[data-place-dialog-close]').forEach(button => button.addEventListener('click', closePlaceMarkDialog));
    $('layerEditForm').addEventListener('submit', event => {
      event.preventDefault();
      const entry = workspaceLayerEntries.get(activeLayerEditId);
      const name = $('layerEditName').value.trim();
      const error = $('layerEditFormError');
      if (!entry) {
        error.textContent = 'This layer is no longer available.';
        error.hidden = false;
        return;
      }
      const transparencyOnly = $('layerEditDialogTitle').textContent === 'Layer transparency';
      if (!name && !transparencyOnly) {
        error.textContent = 'Enter a layer name.';
        error.hidden = false;
        $('layerEditName').focus();
        return;
      }
      if (!transparencyOnly) entry.name = name;
      if (entry.metadata?.kind === 'place-mark-group') {
        (entry.metadata.placeMarks || []).forEach(mark => {
          const record = placeMarkRecords.get(mark.id);
          if (record?.layer?.feature?.properties) record.layer.feature.properties.layerName = name;
        });
        persistPlaceMarkGroups();
      }
      if (!$('layerEditOpacityField').hidden) {
        entry.opacity = Number($('layerEditOpacity').value) / 100;
        applyLayerOpacity(entry);
      }
      renderWorkspaceLayers();
      closeLayerEditDialog();
      toast(transparencyOnly ? `${entry.name} transparency updated.` : `${name} updated.`);
    });
    $('layerEditOpacity').addEventListener('input', event => {
      $('layerEditOpacityValue').textContent = `${event.target.value}%`;
    });
    $('layerEditDialog').querySelectorAll('[data-layer-dialog-close]').forEach(button => button.addEventListener('click', closeLayerEditDialog));
  }

  function renderWorkspaceLayers() {
    const host = $('workspaceLayersList');
    if (!host) return;
    closeWorkspaceLayerMenus();
    document.querySelectorAll('.workspace-layer-menu[data-portal="true"]').forEach(menu => menu.remove());
    const oldPositions = new Map([...host.querySelectorAll('.workspace-layer-row')]
      .map(row => [row.dataset.layerId, row.getBoundingClientRect().top]));
    host.replaceChildren();
    if (!workspaceLayerOrder.length) {
      const empty = document.createElement('div');
      empty.className = 'workspace-layer-empty';
      empty.textContent = 'Analysis results and map drawings will appear here.';
      host.append(empty);
      return;
    }

    workspaceLayerOrder.forEach(id => {
      const entry = workspaceLayerEntries.get(id);
      if (!entry) return;
      const wrap = document.createElement('div');
      wrap.className = 'workspace-layer-wrap';
      const row = document.createElement('div');
      row.className = 'workspace-layer-row';
      row.draggable = true;
      row.dataset.layerId = id;
      const handle = document.createElement('span');
      handle.className = 'workspace-layer-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder';
      const title = document.createElement('div');
      title.className = 'workspace-layer-title';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const type = document.createElement('small');
      type.textContent = entry.source ? `${entry.type} · ${entry.source}` : entry.type;
      title.append(name, type);

      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'workspace-layer-expand';
      const isOsmGroup = id === 'osm-history-results';
      const expanded = state.workspaceExpandedGroups.has(id);
      expand.textContent = '›';
      expand.hidden = !isOsmGroup;
      expand.title = expanded ? 'Collapse yearly layers' : 'Expand yearly layers';
      expand.setAttribute('aria-label', expand.title);
      expand.setAttribute('aria-expanded', String(expanded));
      expand.addEventListener('click', () => {
        if (state.workspaceExpandedGroups.has(id)) state.workspaceExpandedGroups.delete(id);
        else state.workspaceExpandedGroups.add(id);
        renderWorkspaceLayers();
      });

      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = 'workspace-layer-visibility';
      visibility.innerHTML = entry.visible
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.2-6.3 9.5-6.3 9.5 6.3 9.5 6.3-3.2 6.3-9.5 6.3S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/><path d="m18.5 4.5 2 2"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.9A10.8 10.8 0 0 1 12 5.8c6.3 0 9.5 6.2 9.5 6.2a16.4 16.4 0 0 1-3.2 3.8M6.2 6.4C3.8 8 2.5 12 2.5 12s3.2 6.3 9.5 6.3c1.4 0 2.6-.3 3.7-.8"/><path d="M9.8 9.8a3.1 3.1 0 0 0 4.4 4.4"/></svg>';
      visibility.title = entry.visible ? 'Hide layer' : 'Show layer';
      visibility.setAttribute('aria-label', visibility.title);
      visibility.setAttribute('aria-pressed', String(entry.visible));
      visibility.addEventListener('click', () => setWorkspaceLayerVisible(id, !entry.visible));

      const menuButton = document.createElement('button');
      menuButton.type = 'button';
      menuButton.className = 'workspace-layer-menu-button';
      menuButton.textContent = '⋮';
      menuButton.title = 'Layer options';
      menuButton.setAttribute('aria-label', `Options for ${entry.name}`);
      menuButton.setAttribute('aria-haspopup', 'menu');
      menuButton.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'workspace-layer-menu';
      menu.setAttribute('role', 'menu');
      menu.dataset.portal = 'true';
      menu.hidden = true;
      const action = (label, callback, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('role', 'menuitem');
        button.disabled = disabled;
        button.addEventListener('click', () => { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); callback(); });
        menu.append(button);
      };
      action('Zoom to layer', () => zoomToWorkspaceLayer(entry));
      action('Rename layer', () => openLayerEditDialog(entry, true));
      action('Edit layer', () => {
        if (entry.metadata?.kind === 'place-mark' && typeof entry.layer.getLatLng === 'function') {
          openPlaceMarkDialog(entry.layer.getLatLng(), entry);
        } else {
          openLayerEditDialog(entry, false);
        }
      });
      action('Transparency', () => openLayerEditDialog(entry, false, true));
      action('Remove layer', () => removeWorkspaceLayer(id));
      const separator = document.createElement('div');
      separator.className = 'workspace-layer-menu-divider';
      separator.setAttribute('role', 'separator');
      menu.append(separator);
      action('Export layer', () => exportWorkspaceEntry(entry));
      if (isOsmGroup) {
        action('Export all years · GeoJSON', () => exportGeoJSON(true));
        action('Export point audit · CSV', () => exportCSV());
        action('Export history · KML', () => exportKML());
      }
      action('Move to top', () => {
        workspaceLayerOrder = workspaceLayerOrder.filter(key => key !== id);
        workspaceLayerOrder.unshift(id);
        applyWorkspaceLayerOrder(); renderWorkspaceLayers();
      });
      action('Move to bottom', () => {
        workspaceLayerOrder = workspaceLayerOrder.filter(key => key !== id);
        workspaceLayerOrder.push(id);
        applyWorkspaceLayerOrder(); renderWorkspaceLayers();
      });
      menuButton.addEventListener('click', event => {
        event.stopPropagation();
        const wasOpen = !menu.hidden;
        closeWorkspaceLayerMenus();
        if (wasOpen) return;
        positionWorkspaceLayerMenu(menu, menuButton);
        menuButton.setAttribute('aria-expanded', 'true');
      });

      row.addEventListener('dragstart', event => {
        draggingWorkspaceLayer = id;
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => { draggingWorkspaceLayer = ''; row.classList.remove('dragging'); document.querySelectorAll('.workspace-layer-row').forEach(item => item.classList.remove('drop-target', 'drop-before', 'drop-after')); });
      row.addEventListener('dragover', event => {
        if (!draggingWorkspaceLayer || draggingWorkspaceLayer === id) return;
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        const before = event.clientY < bounds.top + bounds.height / 2;
        row.classList.add('drop-target');
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', event => {
        if (!row.contains(event.relatedTarget)) row.classList.remove('drop-target', 'drop-before', 'drop-after');
      });
      row.addEventListener('drop', event => {
        event.preventDefault();
        row.classList.remove('drop-target', 'drop-before', 'drop-after');
        const from = draggingWorkspaceLayer || event.dataTransfer.getData('text/plain');
        if (!from || from === id || !workspaceLayerEntries.has(from)) return;
        const before = event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        workspaceLayerOrder = workspaceLayerOrder.filter(key => key !== from);
        const at = workspaceLayerOrder.indexOf(id);
        workspaceLayerOrder.splice(at + (before ? 0 : 1), 0, from);
        applyWorkspaceLayerOrder();
        renderWorkspaceLayers();
      });

      row.append(handle, title, expand, visibility, menuButton);
      wrap.append(row);
      document.body.append(menu);

      if (isOsmGroup && expanded) {
        const years = document.createElement('div');
        years.className = 'workspace-layer-subcontent';
        const orderedYears = state.yearOrder.slice();
        orderedYears.forEach(year => {
          const versions = state.versions.filter(version => yearOf(version) === year);
          const yearRow = document.createElement('label');
          yearRow.className = 'workspace-year-row';
          const text = document.createElement('span');
          text.innerHTML = `${escapeHTML(year)}<small>${versions.length} ${versions.length === 1 ? 'version' : 'versions'}</small>`;
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.checked = versions.length > 0 && versions.every(version => state.layers.get(version.version) !== false);
          check.indeterminate = versions.some(version => state.layers.get(version.version) !== false) && !check.checked;
          check.setAttribute('aria-label', `Show all OSM versions from ${year}`);
          check.addEventListener('change', () => {
            versions.forEach(version => setLayerVisible(version.version, check.checked, false));
            fitVisible();
            renderLayers();
            renderWorkspaceLayers();
          });
          yearRow.append(text, check);
          years.append(yearRow);
        });
        wrap.append(years);
      }
      host.append(wrap);
    });

    // FLIP animation: preserve the visual position of rows while their order changes.
    const rows = [...host.querySelectorAll('.workspace-layer-row')];
    rows.forEach(row => {
      const previousTop = oldPositions.get(row.dataset.layerId);
      if (previousTop == null) return;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        row.style.transition = '';
        row.style.transform = '';
      });
    });
  }

  function exportWorkspaceEntry(entry) {
    if (!entry?.layer) return;
    if (entry.id === 'osm-history-results') {
      exportGeoJSON(true);
      return;
    }
    const layer = entry.layer;
    if (typeof layer.toGeoJSON === 'function') {
      const geojson = layer.toGeoJSON();
      downloadBlob(JSON.stringify(geojson, null, 2), 'application/geo+json', `${safeFileName(entry.name)}.geojson`);
      toast(`${entry.name} exported as GeoJSON.`);
      return;
    }
    const image = typeof layer.getElement === 'function' ? layer.getElement() : null;
    const src = image?.src || layer._url || '';
    if (src.startsWith('data:image/')) {
      const link = document.createElement('a');
      link.href = src;
      link.download = `${safeFileName(entry.name)}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      toast(`${entry.name} exported as PNG image.`);
      return;
    }
    if (entry.type === 'Basemap') {
      const config = BASEMAPS[entry.metadata?.basemapId];
      downloadBlob(JSON.stringify({ name: entry.name, type: 'XYZ tile basemap', tileUrl: entry.metadata?.tileUrl || config?.url || '', attribution: config?.options?.attribution || '', notice: 'This is basemap source metadata, not a downloaded tile package. Follow the provider terms for tile use.' }, null, 2), 'application/json', `${safeFileName(entry.name)}-source.json`);
      toast('Basemap source details exported. Tile imagery remains with its provider.');
      return;
    }
    toast(`The ${entry.type.toLowerCase()} layer does not expose a direct export format.`);
  }

  function safeFileName(value) {
    return String(value || 'neelvaan-layer').normalize('NFKD').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'neelvaan-layer';
  }

  // Public no-key tile endpoints. Each provider has separate terms and fair-use limits.
  // CARTO was intentionally removed because its current unauthenticated service can show an API-key watermark.
  const BASEMAPS = {
    osm: {
      label: 'OpenStreetMap Standard',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' }
    },
    hot: {
      label: 'Humanitarian (HOT)',
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      options: { subdomains: 'abc', maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>' }
    },
    osmfr: {
      label: 'OSM France',
      url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
      options: { subdomains: 'abc', maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Style by <a href="https://openstreetmap.fr/">OSM France</a>' }
    },
    osmde: {
      label: 'OSM Germany',
      url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Tiles <a href="https://openstreetmap.de/">openstreetmap.de</a>' }
    },
    english: {
      label: 'OSM English Labels',
      url: 'https://cdn.lima-labs.com/{z}/{x}/{y}.png?api=demo',
      options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · English-label tiles by <a href="https://maps.lima-labs.com/">Lima Labs</a>' }
    },
    cycle: {
      label: 'CyclOSM',
      url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      options: { subdomains: 'abc', maxZoom: 20, attribution: '<a href="https://www.cyclosm.org/">CyclOSM</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' }
    },
    topo: {
      label: 'OpenTopoMap-R',
      url: 'https://tile.openmaps.fr/opentopomap/{z}/{x}/{y}.png',
      options: { maxZoom: 17, attribution: '<a href="https://github.com/sletuffe/OpenTopoMap">OpenTopoMap-R</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · <a href="https://openmaps.fr/donate">Tile server support</a>' }
    },
    imagery: {
      label: 'Satellite · Esri / Maxar',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    street: {
      label: 'Esri Street',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    worldtopo: {
      label: 'Esri Topographic',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    gray: {
      label: 'Esri Gray Canvas',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 16, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    terrain: {
      label: 'Esri Terrain',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 13, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    ocean: {
      label: 'Esri Ocean',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 13, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    natgeo: {
      label: 'Esri National Geographic',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 16, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community' }
    },
    hiking: {
      label: 'OpenHikingMap',
      url: 'https://tile.openmaps.fr/openhikingmap/{z}/{x}/{y}.png',
      options: { maxZoom: 18, attribution: '<a href="https://wiki.openstreetmap.org/wiki/OpenHikingMap">OpenHikingMap</a> · <a href="https://openmaps.fr/donate">Tile server support</a>' }
    },
    nasa: {
      label: 'NASA Blue Marble',
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg',
      options: { maxZoom: 8, attribution: 'Imagery courtesy of <a href="https://www.earthdata.nasa.gov/data/instruments/gibs">NASA GIBS</a>' }
    }
  };

  function setBasemap(name) {
    if (!state.map || !BASEMAPS[name]) return null;
    const config = BASEMAPS[name];
    const nextLayer = L.tileLayer(config.url, {
      ...config.options,
      crossOrigin: true,
      updateWhenIdle: true,
      keepBuffer: 2
    });
    nextLayer.on('tileerror', () => {
      const now = Date.now();
      if (now - state.lastTileErrorAt > 5000) {
        state.lastTileErrorAt = now;
        toast(`${config.label} tiles are not responding. Try another basemap; public tile services can be rate-limited or unavailable.`);
      }
    });
    basemapSequence += 1;
    const id = createStableId(`basemap-${name}-${basemapSequence}`);
    state.tileLayer = nextLayer;
    state.basemap = name;
    const entry = addWorkspaceLayer({
      id, name: config.label, type: 'Basemap', source: `Base map · ${name}`,
      metadata: { kind: 'basemap', basemapId: name, tileUrl: config.url },
      layer: nextLayer, visible: true, opacity: 1
    });
    renderBasemapGallery();
    toast(`${config.label} added as a separate Map Content layer. Earlier basemaps are kept.`);
    return entry;
  }

  function renderBasemapGallery() {
    const host = $('basemapOptions');
    if (!host) return;
    host.replaceChildren();
    Object.entries(BASEMAPS).forEach(([id, config]) => {
      const card = document.createElement('article');
      card.className = `basemap-gallery-card${id === state.basemap ? ' active' : ''}`;
      card.dataset.basemapId = id;
      const preview = document.createElement('div');
      preview.className = 'basemap-preview';
      const image = document.createElement('img');
      const sampleUrl = config.url.replaceAll('{s}', 'a').replaceAll('{z}', '5').replaceAll('{x}', '23').replaceAll('{y}', '14');
      image.src = sampleUrl;
      image.alt = `${config.label} map preview`;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { image.hidden = true; preview.classList.add('preview-unavailable'); });
      const badge = document.createElement('span');
      badge.className = 'basemap-preview-badge';
      badge.textContent = id === state.basemap ? 'LATEST' : 'BASE MAP';
      preview.append(image, badge);
      const title = document.createElement('div');
      title.className = 'basemap-card-title';
      title.textContent = config.label;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'basemap-add-button';
      add.dataset.basemapAdd = id;
      add.textContent = 'Add to Map Content';
      add.addEventListener('click', () => setBasemap(id));
      card.append(preview, title, add);
      host.append(card);
    });
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');

    clearTimeout(state.toastTimer);

    state.toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 3600);
  }

  function setLoading(on, title = 'Preparing history…', detail = 'Please keep this tab open.', percent = 0) {
    $('loadingOverlay').hidden = !on;
    $('loadingTitle').textContent = title;
    $('loadingDetail').textContent = detail;
    $('progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;

    const importButton = $('osmImportBtn');
    if (importButton) importButton.disabled = on;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function formatDate(value) {
    if (!value) return 'Date not recorded';

    const date = new Date(value);

    return Number.isNaN(date.getTime())
      ? 'Date not recorded'
      : new Intl.DateTimeFormat(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
          timeZoneName: 'short'
        }).format(date);
  }

  function yearOf(version) {
    const d = new Date(version.timestamp);

    return Number.isNaN(d.getTime())
      ? 'Unknown year'
      : String(d.getUTCFullYear());
  }

  function colorFor(index) {
    // Golden-angle hue spacing gives each version its own high-contrast colour.
    const hue = (index * 137.508) % 360;
    return `hsl(${hue.toFixed(2)} 92% 52%)`;
  }

  function parseTags(element) {
    return [...element.children]
      .filter(child => child.localName === 'tag')
      .map(tag => ({ k: tag.getAttribute('k') || '', v: tag.getAttribute('v') || '' }));
  }

  function objectRecord(element, type, fallbackVersion) {
    const id = element.getAttribute('id') || '';
    const sourceVersion = Number(element.getAttribute('version') || fallbackVersion || 1);
    const nodeIds = type === 'way'
      ? [...element.children].filter(child => child.localName === 'nd').map(nd => nd.getAttribute('ref')).filter(Boolean)
      : type === 'node' ? [id] : [];
    const members = type === 'relation'
      ? [...element.children].filter(child => child.localName === 'member').map(member => ({
          type: member.getAttribute('type') || '',
          ref: member.getAttribute('ref') || '',
          role: member.getAttribute('role') || ''
        })).filter(member => member.ref && ['node', 'way', 'relation'].includes(member.type))
      : [];

    return {
      id,
      version: sourceVersion,
      sourceVersion,
      type,
      timestamp: element.getAttribute('timestamp') || '',
      user: element.getAttribute('user') || '',
      changeset: element.getAttribute('changeset') || '',
      visible: element.getAttribute('visible') !== 'false',
      nodeIds,
      members,
      tags: parseTags(element),
      lat: type === 'node' && element.hasAttribute('lat') ? Number(element.getAttribute('lat')) : null,
      lon: type === 'node' && element.hasAttribute('lon') ? Number(element.getAttribute('lon')) : null
    };
  }

  function parseObjectXml(xmlText, filename = 'history.xml') {
    if (!xmlText.trim()) throw new Error('The selected file is empty. Choose an OSM XML file.');
    if (/<!DOCTYPE/i.test(xmlText)) throw new Error('DOCTYPE declarations are not accepted for safety. Download a standard OSM XML file and try again.');

    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('This file is not valid XML. Please check the download and try again.');
    const root = doc.documentElement;
    if (!root || !['osm', 'osmChange'].includes(root.localName)) {
      throw new Error('This does not look like standard OpenStreetMap XML. Expected an <osm> history or <osmChange> file.');
    }

    const safeIntegerId = id => /^\d+$/.test(String(id || ''));
    const isChangeFile = root.localName === 'osmChange';
    let records = [];

    if (isChangeFile) {
      const wrappers = [...root.children].filter(el => ['create', 'modify', 'delete'].includes(el.localName));
      wrappers.forEach(wrapper => {
        [...wrapper.children].filter(el => ['node', 'way', 'relation'].includes(el.localName)).forEach(el => {
          const record = objectRecord(el, el.localName, records.length + 1);
          if (!/^\d+$/.test(record.id) || !Number.isSafeInteger(Number(record.id))) {
            throw new Error(`The changeset contains an invalid ${el.localName} ID.`);
          }
          record.action = wrapper.localName;
          record.visible = wrapper.localName !== 'delete' && record.visible;
          records.push(record);
        });
      });
      if (!records.length) throw new Error('This changeset XML does not contain any created, modified or deleted OSM objects.');
      if (records.length > MAX_VERSIONS) throw new Error(`This changeset contains more than ${MAX_VERSIONS.toLocaleString()} changed objects, above the current browser-safe limit.`);

      records = records.map((record, index) => ({
        ...record,
        version: index + 1,
        sourceVersion: record.sourceVersion || null,
        changeset: record.changeset || '',
        syntheticVersion: true
      }));

      const fileMatch = String(filename).match(/changeset[-_ ]?(\d+)/i);
      const firstChangeset = records.find(r => r.changeset)?.changeset;
      const id = fileMatch?.[1] || firstChangeset || 'download';
      return { type: 'changeset', id, versions: records, source: doc };
    }

    records = [...root.children]
      .filter(el => ['node', 'way', 'relation'].includes(el.localName))
      .map((el, index) => objectRecord(el, el.localName, index + 1));

    if (!records.length) {
      throw new Error('No node, way or relation records were found in this OSM XML.');
    }

    const types = [...new Set(records.map(record => record.type))];
    const ids = [...new Set(records.map(record => record.id))];
    if (types.length !== 1 || ids.length !== 1) {
      throw new Error('Upload one object history at a time (all versions of one Node, Way or Relation), or upload a Changeset Download XML.');
    }
    if (!safeIntegerId(records[0].id)) throw new Error('The OSM object ID in this file is not a valid numeric ID.');

    const type = types[0];
    const id = records[0].id;
    if (records.some(record => !Number.isSafeInteger(record.version) || record.version < 1)) {
      throw new Error(`The ${type} history contains an invalid version number.`);
    }
    if (type === 'way' && records.some(record => !record.nodeIds.length && record.visible)) {
      throw new Error(`Way ${id} contains a visible version with no node references.`);
    }
    if (records.some(record => record.type === 'way' && record.nodeIds.some(nodeId => !safeIntegerId(nodeId)))) {
      throw new Error(`Way ${id} contains an invalid node reference.`);
    }
    if (records.length > MAX_VERSIONS) throw new Error(`This file contains more than ${MAX_VERSIONS.toLocaleString()} versions, above the current browser-safe limit.`);

    records.sort((a, b) => a.version - b.version);
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.version)) throw new Error(`Duplicate version ${record.version} was found. Please download the object history again.`);
      seen.add(record.version);
    }
    return { type, id, versions: records, source: doc };
  }

  function entityLabel(type, id) {
    const names = { node: 'Node', way: 'Way', relation: 'Relation', changeset: 'Changeset' };
    return `${names[type] || 'OSM object'} ${id}`;
  }

  function historyLabel(version) {
    if (state.objectType === 'changeset') {
      const action = version.action ? ` · ${version.action.toUpperCase()}` : '';
      return `${entityLabel(version.type || 'way', version.id)}${version.sourceVersion ? ` · v${version.sourceVersion}` : ''}${action}`;
    }
    return `Version ${version.version}`;
  }

  async function handleFile(file, source = 'file') {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast('File is larger than 30 MB.'); return; }
    if (!/\.(xml|osm)$/i.test(file.name) && file.type && !/xml/i.test(file.type)) { toast('Please choose an XML or OSM file.'); return; }

    const generation = ++state.generation;
    setLoading(true, 'Reading OSM XML…', file.name, 3);
    try {
      const xmlText = await file.text();
      if (generation !== state.generation) return;
      const parsed = parseObjectXml(xmlText, file.name);
      if (state.searchMarker && state.map) state.map.removeLayer(state.searchMarker);
      state.searchMarker = null;
      const versions = parsed.versions;
      const uniqueNodes = new Set();
      versions.forEach(version => {
        (version.nodeIds || []).forEach(id => uniqueNodes.add(id));
        (version.members || []).filter(member => member.type === 'node').forEach(member => uniqueNodes.add(member.ref));
      });
      if (uniqueNodes.size > MAX_UNIQUE_NODES) throw new Error(`This history refers to more than ${MAX_UNIQUE_NODES.toLocaleString()} unique points. The current limit keeps the browser responsive.`);

      state.versions = versions;
      state.source = source;
      state.objectType = parsed.type;
      state.objectId = parsed.id;
      state.uniqueNodeCount = uniqueNodes.size;
      state.histories.clear();
      state.memberWayHistories.clear();
      state.analyses.clear();
      state.layers.clear();
      state.collapsedYears.clear();
      state.layerOrder.clear();
      state.yearOrder = [...new Set(versions.map(yearOf))].sort((a, b) =>
        a === 'Unknown year' ? 1 : b === 'Unknown year' ? -1 : Number(b) - Number(a)
      );
      state.yearOrder.forEach(year => {
        state.layerOrder.set(year, versions.filter(v => yearOf(v) === year).map(v => v.version).reverse());
      });

      // Node history XML already contains the point's historical coordinates.
      if (parsed.type === 'node') {
        state.histories.set(parsed.id, versions.map(v => ({
          id: v.id, version: v.version, lat: v.lat, lon: v.lon,
          timestamp: v.timestamp, visible: v.visible, user: v.user
        })));
      }
      // A changeset download contains changed node positions as well as ways/relations.
      if (parsed.type === 'changeset') {
        const groupedNodes = new Map();
        versions.filter(v => v.type === 'node').forEach(v => {
          if (!groupedNodes.has(v.id)) groupedNodes.set(v.id, []);
          groupedNodes.get(v.id).push({ id: v.id, version: v.sourceVersion || v.version, lat: v.lat, lon: v.lon, timestamp: v.timestamp, visible: v.visible, user: v.user });
        });
        groupedNodes.forEach((history, id) => state.histories.set(id, history));
      }

      state.selected = versions[versions.length - 1];
      $('layersEmpty').hidden = true;
      $('layerControls').hidden = false;
      $('analysisEmpty').hidden = true;
      $('analysisContent').hidden = false;
      showPanel('osm');
      renderLayers();
      renderAnalysis();
      await loadAllGeometry(generation);
      if (generation !== state.generation) return;
      const versionToRestore = requestedRestoreVersion && versions.some(v => v.version === Number(requestedRestoreVersion))
        ? Number(requestedRestoreVersion)
        : state.selected.version;
      requestedRestoreVersion = null;
      selectVersion(versionToRestore, true);
      toast(`Loaded ${versions.length} ${parsed.type === 'changeset' ? 'changeset objects' : 'history records'} successfully.`);
      window.dispatchEvent(new CustomEvent('vaanam:workspace-result', { detail: { kind: 'osm-history', label: `${parsed.type.toUpperCase()} ${parsed.id}`, summary: { objectType: parsed.type, objectId: parsed.id, versions: versions.length, source } } }));
      window.dispatchEvent(new Event('vaanam:state-change'));
    } catch (error) {
      if (generation !== state.generation) return;
      toast(error.message || 'Could not read this OSM XML.');
    } finally {
      if (generation === state.generation) setLoading(false);
    }
  }

  async function fetchNodeHistory(nodeId, generation) {
    if (state.histories.has(nodeId)) {
      return state.histories.get(nodeId);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      let response;
      let body;

      try {
        response = await fetch(
          `${API}/node/${encodeURIComponent(nodeId)}/history`,
          {
            headers: { Accept: 'application/xml' },
            signal: controller.signal
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        body = await response.text();
      } finally {
        clearTimeout(timeout);
      }

      if (generation !== state.generation) return [];

      const doc = new DOMParser().parseFromString(body, 'application/xml');

      if (doc.querySelector('parsererror')) {
        throw new Error('Invalid node history XML');
      }

      const history = [...doc.getElementsByTagName('node')].map(node => {
        const lat = Number(node.getAttribute('lat'));
        const lon = Number(node.getAttribute('lon'));

        return {
          id: node.getAttribute('id') || nodeId,
          version: Number(node.getAttribute('version') || 0),
          lat,
          lon,
          timestamp: node.getAttribute('timestamp') || '',
          visible: node.getAttribute('visible') !== 'false',
          user: node.getAttribute('user') || ''
        };
      });

      state.histories.set(nodeId, history);
      return history;
    } catch (error) {
      if (generation === state.generation) {
        state.histories.set(nodeId, {
          failed: true,
          message: error.message
        });
      }

      return {
        failed: true,
        message: error.message
      };
    }
  }

  async function fetchMemberWayHistory(wayId, generation) {
    if (state.memberWayHistories.has(wayId)) return state.memberWayHistories.get(wayId);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      let response;
      try {
        response = await fetch(`${API}/way/${encodeURIComponent(wayId)}/history`, {
          headers: { Accept: 'application/xml' }, signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (generation !== state.generation) return [];
        const doc = new DOMParser().parseFromString(body, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('Invalid way history XML');
        const ways = [...doc.documentElement.children]
          .filter(el => el.localName === 'way')
          .map((el, index) => objectRecord(el, 'way', index + 1))
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.version - b.version);
        state.memberWayHistories.set(wayId, ways);
        return ways;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (generation === state.generation) state.memberWayHistories.set(wayId, { failed: true, message: error.message });
      return { failed: true, message: error.message };
    }
  }

  function historicalPosition(history, timestamp) {
    if (!Array.isArray(history)) return null;

    const target = Date.parse(timestamp);

    if (!Number.isFinite(target)) return null;

    let best = null;
    let bestTime = -Infinity;

    for (const item of history) {
      const time = Date.parse(item.timestamp);

      if (
        item.visible &&
        Number.isFinite(item.lat) &&
        Number.isFinite(item.lon) &&
        Math.abs(item.lat) <= 90 &&
        Math.abs(item.lon) <= 180 &&
        Number.isFinite(time) &&
        time <= target &&
        time > bestTime
      ) {
        best = item;
        bestTime = time;
      }
    }

    return best;
  }

  async function loadAllGeometry(generation) {
    // Relation snapshots refer to member ways. Fetch their version histories first,
    // then resolve each member's node coordinates at the relation's timestamp.
    const memberWayIds = [...new Set(state.versions.flatMap(v =>
      (v.members || []).filter(member => member.type === 'way').map(member => member.ref)
    ))];
    let wayCursor = 0;
    const wayWorkers = Array.from({ length: Math.min(CONCURRENCY, memberWayIds.length) }, async () => {
      while (wayCursor < memberWayIds.length && generation === state.generation) {
        const id = memberWayIds[wayCursor++];
        await fetchMemberWayHistory(id, generation);
      }
    });
    await Promise.all(wayWorkers);
    if (generation !== state.generation) return;

    const nodeIds = new Set();
    state.versions.forEach(v => {
      (v.nodeIds || []).forEach(id => nodeIds.add(id));
      (v.members || []).filter(member => member.type === 'node').forEach(member => nodeIds.add(member.ref));
    });
    state.memberWayHistories.forEach(history => {
      if (Array.isArray(history)) history.forEach(way => (way.nodeIds || []).forEach(id => nodeIds.add(id)));
    });
    const ids = [...nodeIds];
    if (ids.length > MAX_UNIQUE_NODES) {
      throw new Error(`This object references ${ids.length.toLocaleString()} unique points across its member histories, above the current limit of ${MAX_UNIQUE_NODES.toLocaleString()}. Try a smaller relation or a way history.`);
    }

    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length && generation === state.generation) {
        const id = ids[cursor++];
        const history = await fetchNodeHistory(id, generation);
        if (history && history.failed) failed++;
        completed++;
        if (completed % 5 === 0 || completed === ids.length) {
          const pct = ids.length ? Math.round(completed / ids.length * 100) : 100;
          setLoading(true, 'Finding historical point positions…', `${completed.toLocaleString()} of ${ids.length.toLocaleString()} points checked · ${failed} unavailable`, pct);
        }
      }
    });
    await Promise.all(workers);
    if (generation !== state.generation) return;

    state.uniqueNodeCount = ids.length;
    state.analyses.clear();
    for (const version of state.versions) state.analyses.set(version.version, buildAnalysis(version));
    renderLayers();
    renderAnalysis();
    if (failed) toast(`${failed} point histories could not be reached. Some geometries may have gaps.`);
    const failedWays = [...state.memberWayHistories.values()].filter(item => item?.failed).length;
    if (failedWays) toast(`${failedWays} relation member way histories could not be reached. Some relation geometry may be incomplete.`);
  }

  function resolvePoint(id, timestamp, order) {
    const history = state.histories.get(id);
    const exact = historicalPosition(history, timestamp);
    const latest = Array.isArray(history)
      ? history.filter(n => n.visible && Number.isFinite(n.lat) && Number.isFinite(n.lon) && Math.abs(n.lat) <= 90 && Math.abs(n.lon) <= 180)
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]
      : null;
    return {
      id, order,
      lat: exact?.lat ?? null,
      lon: exact?.lon ?? null,
      status: exact ? 'exact' : history?.failed ? 'unavailable' : latest ? 'newer-only' : 'deleted-or-missing',
      latest: latest ? { lat: latest.lat, lon: latest.lon, timestamp: latest.timestamp } : null
    };
  }

  // Spherical ring area (m²). Longitude deltas are wrapped so a ring crossing
  // the antimeridian is measured across the short arc, not around the globe.
  function ringAreaM2(coords) {
    if (!Array.isArray(coords) || coords.length < 4) return null;
    const first = coords[0], last = coords[coords.length - 1];
    if (Math.abs(first[0] - last[0]) > 1e-7 || Math.abs(first[1] - last[1]) > 1e-7) return null;
    const r = 6371008.8;
    let sum = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [lat1, lon1] = coords[i], [lat2, lon2] = coords[i + 1];
      let dLon = lon2 - lon1;
      while (dLon > 180) dLon -= 360;
      while (dLon < -180) dLon += 360;
      sum += dLon * Math.PI / 180 * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
    }
    return Math.abs(sum * r * r / 2);
  }

  function formatArea(m2) {
    if (!Number.isFinite(m2)) return 'Not measurable';
    return m2 >= 1000000 ? `${(m2 / 1000000).toLocaleString(undefined, { maximumFractionDigits: 3 })} km²` : `${Math.round(m2).toLocaleString()} m²`;
  }

  function tagsObject(tags) {
    return Object.fromEntries((tags || []).map(t => [t.k, t.v]));
  }

  // OSM closed ways are not automatically areas: roads, waterways and other
  // linear features can be closed loops. Honour area=yes/no and known area tags.
  function isAreaWay(tags) {
    const t = tagsObject(tags);
    if (t.area === 'no') return false;
    if (t.area === 'yes') return true;
    // Do not let unrelated tags such as access=no turn a building into a line.
    // Only assess values on keys that can independently indicate an area.
    const areaKeys = ['building','landuse','leisure','amenity','shop','tourism','historic','military','boundary','place','office','craft','indoor','natural'];
    const negative = new Set(['no','false','0','vacant','closed','disused','abandoned','demolished','razed','empty']);
    if (areaKeys.some(key => negative.has(String(t[key] || '').toLowerCase()))) {
      const otherAreaTag = areaKeys.some(key => t[key] && !negative.has(String(t[key]).toLowerCase()));
      if (!otherAreaTag) return false;
    }
    if (['highway', 'waterway', 'railway', 'route', 'barrier', 'aerialway'].some(k => t[k])) return false;
    if (t.leisure === 'track') return false;
    if (['building', 'landuse', 'leisure', 'amenity', 'shop', 'tourism', 'historic', 'military', 'boundary', 'place', 'office', 'craft', 'indoor'].some(k => t[k] && !negative.has(String(t[k]).toLowerCase()))) return true;
    if (t.natural && !negative.has(String(t.natural).toLowerCase()) && !['coastline', 'cliff', 'ridge', 'tree_row', 'arete', 'scree_slope'].includes(t.natural)) return true;
    return false;
  }

  function isAreaRelation(version) {
    const t = tagsObject(version.tags);
    if (t.area === 'no') return false;
    if (t.area === 'yes' || t.type === 'multipolygon' || t.type === 'boundary') return true;
    const negative = new Set(['no','false','0','vacant','closed','disused','abandoned','demolished','razed','empty']);
    return ['building','landuse','leisure','amenity','shop','tourism','historic','military','boundary','place','office','craft','indoor','natural']
      .some(key => t[key] && !negative.has(String(t[key]).toLowerCase()) && !(key === 'leisure' && t[key] === 'track'));
  }

  function pointInRing(point, ring) {
    const x = point[1], y = point[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][1], yi = ring[i][0], xj = ring[j][1], yj = ring[j][0];
      const intersects = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  // Conservative linework polygonizer. It accepts only closed degree-2
  // components, honours multipolygon inner/outer roles, and never snaps gaps.
  function detectClosedLinework(segments, segmentRoles = []) {
    const nodes = new Map(), edges = new Map();
    const keyOf = c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
    (segments || []).forEach((segment, segmentIndex) => {
      const role = String(segmentRoles[segmentIndex] || '').toLowerCase();
      for (let i = 1; i < segment.length; i++) {
        const a = segment[i - 1], b = segment[i];
        if (!a || !b || !a.every(Number.isFinite) || !b.every(Number.isFinite)) continue;
        const ka = keyOf(a), kb = keyOf(b);
        if (ka === kb) continue;
        if (!nodes.has(ka)) nodes.set(ka, { coord: a, edges: [] });
        if (!nodes.has(kb)) nodes.set(kb, { coord: b, edges: [] });
        const ek = [ka, kb].sort().join('|');
        if (edges.has(ek)) {
          if (role) edges.get(ek).roles.add(role);
          continue;
        }
        edges.set(ek, { a: ka, b: kb, roles: new Set(role ? [role] : []) });
        nodes.get(ka).edges.push(ek);
        nodes.get(kb).edges.push(ek);
      }
    });

    const visitedNodes = new Set(), rings = [];
    let topologyComplete = true;
    const usedEdges = new Set();
    for (const start of nodes.keys()) {
      if (visitedNodes.has(start)) continue;
      const stack = [start], component = [];
      visitedNodes.add(start);
      while (stack.length) {
        const k = stack.pop();
        component.push(k);
        for (const ek of nodes.get(k).edges) {
          const edge = edges.get(ek), other = edge.a === k ? edge.b : edge.a;
          if (!visitedNodes.has(other)) { visitedNodes.add(other); stack.push(other); }
        }
      }
      if (component.length < 3 || component.some(k => nodes.get(k).edges.length !== 2)) {
        topologyComplete = false;
        continue;
      }
      const first = component[0], ring = [nodes.get(first).coord];
      let current = first, previousEdge = null, guard = 0;
      const componentEdges = new Set();
      do {
        const nextEdge = nodes.get(current).edges.find(e => e !== previousEdge);
        if (!nextEdge) break;
        componentEdges.add(nextEdge);
        usedEdges.add(nextEdge);
        const edge = edges.get(nextEdge), next = edge.a === current ? edge.b : edge.a;
        ring.push(nodes.get(next).coord);
        previousEdge = nextEdge;
        current = next;
        guard++;
      } while (current !== first && guard <= component.length + 1);
      if (current !== first || ring.length < 4 || componentEdges.size !== component.length) {
        topologyComplete = false;
        continue;
      }
      const roleSet = new Set([...componentEdges].flatMap(e => [...edges.get(e).roles]).filter(Boolean));
      // Unknown or mixed roles make an area result unsafe.
      if (roleSet.has('ambiguous') || (roleSet.has('inner') && roleSet.has('outer'))) {
        topologyComplete = false;
        continue;
      }
      const role = roleSet.has('inner') ? 'inner' : 'outer';
      const areaM2 = ringAreaM2(ring);
      if (Number.isFinite(areaM2) && areaM2 > 1) rings.push({ coordinates: ring, areaM2, role });
    }

    if (usedEdges.size !== edges.size) topologyComplete = false;
    const outerRings = rings.filter(r => r.role !== 'inner');
    const innerRings = rings.filter(r => r.role === 'inner');
    const polygons = outerRings.map(r => ({ coordinates: r.coordinates, holes: [], outerAreaM2: r.areaM2, areaM2: r.areaM2 }));
    for (const inner of innerRings) {
      const owner = polygons
        .filter(poly => pointInRing(inner.coordinates[0], poly.coordinates))
        .sort((a, b) => a.outerAreaM2 - b.outerAreaM2)[0];
      if (!owner) { topologyComplete = false; continue; }
      owner.holes.push(inner.coordinates);
      owner.areaM2 = Math.max(0, owner.areaM2 - inner.areaM2);
    }
    return {
      polygons,
      topologyComplete,
      areaM2: topologyComplete && polygons.length ? polygons.reduce((sum, p) => sum + p.areaM2, 0) : null
    };
  }

  function buildAnalysis(version) {
    const isRelation = version.type === 'relation' || (state.objectType === 'relation' && version.members?.length);
    if (isRelation && version.members?.length) {
      const points = [];
      const segments = [];
      const segmentRoles = [];
      let order = 1;
      const timestampMs = Date.parse(version.timestamp);
      const areaRelation = isAreaRelation(version);

      for (const member of version.members) {
        if (member.type === 'node') {
          points.push(resolvePoint(member.ref, version.timestamp, order++));
          continue;
        }
        if (member.type !== 'way') continue;
        const history = state.memberWayHistories.get(member.ref);
        if (!Array.isArray(history)) continue;
        const candidates = history.filter(way => way.visible && Number.isFinite(Date.parse(way.timestamp)) && Date.parse(way.timestamp) <= timestampMs);
        candidates.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.version - a.version);
        const chosenWay = candidates[0];
        if (!chosenWay) continue;

        let segment = [];
        const role = member.role === 'inner' ? 'inner' : member.role === 'outer' || !member.role ? 'outer' : 'ambiguous';
        for (const id of chosenWay.nodeIds) {
          const point = resolvePoint(id, version.timestamp, order++);
          points.push(point);
          if (point.lat === null || point.lon === null) {
            if (segment.length > 1) { segments.push(segment); segmentRoles.push(role); }
            segment = [];
          } else {
            segment.push([point.lat, point.lon]);
          }
        }
        if (segment.length > 1) { segments.push(segment); segmentRoles.push(role); }
      }
      const coordinates = points.filter(p => p.lat !== null && p.lon !== null);
      const polygonResult = areaRelation ? detectClosedLinework(segments, segmentRoles) : { polygons: [], topologyComplete: false, areaM2: null };
      return {
        version, points, coordinates, segments,
        areaM2: polygonResult.areaM2,
        detectedPolygons: polygonResult.topologyComplete ? polygonResult.polygons : [],
        networkAreaM2: polygonResult.areaM2,
        isPolygon: Number.isFinite(polygonResult.areaM2),
        missing: points.length - coordinates.length,
        exact: coordinates.length,
        failed: points.filter(p => p.status === 'unavailable').length,
        topologyComplete: (areaRelation ? polygonResult.topologyComplete : null)
      };
    }

    const points = (version.nodeIds || []).map((id, index) => resolvePoint(id, version.timestamp, index + 1));
    const coordinates = points.filter(p => p.lat !== null && p.lon !== null);
    const line = [];
    let segment = [];
    for (const point of points) {
      if (point.lat === null || point.lon === null) {
        if (segment.length > 1) line.push(segment);
        segment = [];
      } else {
        segment.push([point.lat, point.lon]);
      }
    }
    if (segment.length > 1) line.push(segment);
    const areaWay = (version.type || state.objectType) === 'way' && isAreaWay(version.tags);
    const polygonResult = areaWay ? detectClosedLinework(line) : { polygons: [], topologyComplete: false, areaM2: null };
    return {
      version, points, coordinates, segments: line,
      areaM2: polygonResult.areaM2,
      detectedPolygons: polygonResult.topologyComplete ? polygonResult.polygons : [],
      networkAreaM2: polygonResult.areaM2,
      isPolygon: Number.isFinite(polygonResult.areaM2),
      missing: points.length - coordinates.length,
      exact: coordinates.length,
      failed: points.filter(p => p.status === 'unavailable').length,
      topologyComplete: (areaWay ? polygonResult.topologyComplete : null)
    };
  }

  function clearDropIndicators(except = null) {
    document.querySelectorAll('.drop-target-before, .drop-target-after').forEach(el => {
      if (el !== except) el.classList.remove('drop-target-before', 'drop-target-after');
    });
  }

  function renderLayers() {
    const host = $('yearGroups');
    host.replaceChildren();

    const groups = new Map();

    state.versions.forEach(v => {
      const year = yearOf(v);

      if (!groups.has(year)) {
        groups.set(year, []);
      }

      groups.get(year).push({
        ...v,
        color: colorFor(state.yearOrder.indexOf(year))
      });
    });

    $('layerCount').textContent = `${state.versions.length}`;

    const sortedYears = [...groups.keys()].sort((a, b) =>
      state.yearOrder.indexOf(a) - state.yearOrder.indexOf(b)
    );

    sortedYears.forEach(year => {
      const order = state.layerOrder.get(year) || [];
      const items = groups.get(year).slice().sort((a, b) => order.indexOf(a.version) - order.indexOf(b.version));

      const section = document.createElement('section');
      section.className = 'year-group';
      section.dataset.year = year;
      section.draggable = true;
      section.addEventListener('dragstart', e => {
        if (e.target.closest('.version-row')) return;
        state.activeDrag = `group:${year}`;
        e.dataTransfer.setData('text/plain', state.activeDrag);
        e.dataTransfer.effectAllowed = 'move';
        section.classList.add('dragging');
      });
      section.addEventListener('dragend', () => {
        section.classList.remove('dragging', 'drop-target-before', 'drop-target-after');
        state.activeDrag = '';
        clearDropIndicators();
      });
      section.addEventListener('dragover', e => {
        const payload = state.activeDrag || e.dataTransfer.getData('text/plain') || '';
        if (!payload.startsWith('group:')) return;
        e.preventDefault();
        clearDropIndicators(section);
        section.classList.toggle('drop-target-before', e.clientY < section.getBoundingClientRect().top + section.getBoundingClientRect().height / 2);
        section.classList.toggle('drop-target-after', e.clientY >= section.getBoundingClientRect().top + section.getBoundingClientRect().height / 2);
      });
      section.addEventListener('dragleave', e => {
        if (!section.contains(e.relatedTarget)) section.classList.remove('drop-target-before', 'drop-target-after');
      });
      section.addEventListener('drop', e => {
        e.preventDefault();
        const payload = state.activeDrag || e.dataTransfer.getData('text/plain');
        const before = e.clientY < section.getBoundingClientRect().top + section.getBoundingClientRect().height / 2;
        clearDropIndicators();
        if (!payload.startsWith('group:')) return;
        const from = payload.slice(6), to = year;
        if (from === to) return;
        const fromIndex = state.yearOrder.indexOf(from);
        if (fromIndex < 0 || !state.yearOrder.includes(to)) return;
        state.yearOrder.splice(fromIndex, 1);
        const targetIndex = state.yearOrder.indexOf(to);
        state.yearOrder.splice(targetIndex + (before ? 0 : 1), 0, from);
        renderLayers();
      });

      const head = document.createElement('div');
      head.className = 'year-heading';

      const allOn = items.every(v => state.layers.get(v.version) !== false);

      head.innerHTML = `
        <button type="button" class="year-toggle"
          aria-label="Collapse ${escapeHTML(year)}"
          aria-expanded="true">
          <span class="chevron">▶</span>
        </button>
        <input class="year-master" type="checkbox"
          aria-label="Toggle all versions in ${escapeHTML(year)}"
          ${allOn ? 'checked' : ''}>
        <strong>${escapeHTML(year)}</strong>
        <small>${items.length} ${items.length === 1 ? 'version' : 'versions'}</small>
      `;

      const master = head.querySelector('input');
      const collapsed = state.collapsedYears.has(year);
      const toggle = head.querySelector('.year-toggle');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${year}`);

      master.addEventListener('change', () => {
        items.forEach(v => {
          setLayerVisible(v.version, master.checked, false);
        });

        renderLayers();
        fitVisible();
      });

      const list = document.createElement('div');
      list.className = 'version-list';

      items.forEach(v => {
        const row = document.createElement('div');
        row.className = `version-row${state.selected?.version === v.version ? ' selected-layer-row' : ''}`;
        row.draggable = true;
        row.dataset.version = String(v.version);
        row.addEventListener('dragstart', e => {
          e.stopPropagation();
          state.activeDrag = `version:${v.version}`;
          e.dataTransfer.setData('text/plain', state.activeDrag);
          e.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => { row.classList.remove('dragging'); state.activeDrag = ''; clearDropIndicators(); });
        row.addEventListener('dragover', e => {
          const payload = state.activeDrag || e.dataTransfer.getData('text/plain') || '';
          if (!payload.startsWith('version:')) return;
          e.preventDefault(); e.stopPropagation();
          clearDropIndicators(row);
          const before = e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
          row.classList.toggle('drop-target-before', before);
          row.classList.toggle('drop-target-after', !before);
        });
        row.addEventListener('dragleave', e => {
          if (!row.contains(e.relatedTarget)) row.classList.remove('drop-target-before', 'drop-target-after');
        });
        row.addEventListener('drop', e => {
          e.preventDefault(); e.stopPropagation();
          const payload = state.activeDrag || e.dataTransfer.getData('text/plain');
          const before = e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
          clearDropIndicators();
          if (!payload.startsWith('version:')) return;
          const fromVersion = Number(payload.slice(8));
          const fromRecord = state.versions.find(x => x.version === fromVersion);
          if (!fromRecord || yearOf(fromRecord) !== year) return;
          const order = (state.layerOrder.get(year) || items.map(x => x.version)).slice();
          const from = order.indexOf(fromVersion);
          const target = order.indexOf(v.version);
          if (from < 0 || target < 0 || from === target) return;
          order.splice(from, 1);
          const insertAt = order.indexOf(v.version) + (before ? 0 : 1);
          order.splice(insertAt, 0, fromVersion);
          state.layerOrder.set(year, order);
          renderLayers();
        });

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = state.layers.get(v.version) !== false;
        check.setAttribute('aria-label', `Show version ${v.version}`);

        check.addEventListener('change', () => {
          setLayerVisible(v.version, check.checked);
        });

        const swatch = document.createElement('i');
        swatch.className = 'version-color';
        swatch.style.background = v.color;
        swatch.style.color = v.color;

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'version-select';
        select.textContent = `${historyLabel(v)}${v.user ? ` · ${v.user}` : ''}`;
        select.title = `Inspect ${historyLabel(v)}`;

        select.addEventListener('click', () => {
          selectVersion(v.version);
        });

        const date = document.createElement('span');
        date.className = 'version-date';
        date.textContent = shortDate(v.timestamp);

        row.append(check, swatch, select, date);
        list.append(row);
      });

      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';

        toggle.setAttribute('aria-expanded', String(!open));
        toggle.setAttribute('aria-label', `${open ? 'Expand' : 'Collapse'} ${year}`);

        list.hidden = open;
        if (open) state.collapsedYears.add(year);
        else state.collapsedYears.delete(year);
      });

      list.hidden = collapsed;
      section.append(head, list);
      host.append(section);
    });

    filterYears();
  }

  function shortDate(value) {
    const d = new Date(value);

    return Number.isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: '2-digit',
          timeZone: 'UTC'
        }).format(d);
  }

  function setLayerVisible(version, visible, shouldFit = true) {
    state.layers.set(version, visible);
    const layer = state.layers.get(`leaflet:${version}`);
    const historyEntry = workspaceLayerEntries.get('osm-history-results');
    const historyGroup = historyEntry?.layer;

    if (layer && historyGroup && typeof historyGroup.addLayer === 'function') {
      if (visible) historyGroup.addLayer(layer);
      else historyGroup.removeLayer(layer);
    } else if (layer && state.map) {
      if (visible && !state.map.hasLayer(layer)) layer.addTo(state.map);
      if (!visible && state.map.hasLayer(layer)) state.map.removeLayer(layer);
    }

    if (shouldFit) fitVisible();
  }

  function filterYears() {
    const q = $('yearSearch').value.trim().toLowerCase();

    document.querySelectorAll('.year-group').forEach(group => {
      const match =
        group.dataset.year.toLowerCase().includes(q) ||
        [...group.querySelectorAll('.version-select')]
          .some(b => b.textContent.toLowerCase().includes(q));

      group.hidden = !match;
    });
  }

  function drawLayers() {
    if (!state.map) return;
    const historyOutput = L.layerGroup();

    for (const v of state.versions) {
      const analysis = state.analyses.get(v.version);

      if (!analysis) continue;

      const color = colorFor(state.yearOrder.indexOf(yearOf(v)));
      const selected = state.selected?.version === v.version;

      const group = L.layerGroup();

      analysis.segments.forEach(coords => {
        L.polyline(coords, {
          color: '#202825',
          weight: selected ? 10 : 8,
          opacity: selected ? .92 : .68,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false
        }).addTo(group);

        const line = L.polyline(coords, {
          color,
          weight: selected ? 6 : 4,
          opacity: selected ? 1 : .88,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'history-line'
        }).addTo(group);

        line.bindTooltip(`${escapeHTML(entityLabel(v.type || state.objectType, v.id))} · ${escapeHTML(historyLabel(v))}`, {
          sticky: true,
          direction: 'top'
        });

        line.on('click', () => selectVersion(v.version));
      });

      if (state.showAreaOverlay && analysis.detectedPolygons?.length) {
        analysis.detectedPolygons.forEach((item, index) => {
          const polygon = L.polygon([item.coordinates, ...(item.holes || [])], {color, weight:selected?2.5:1.2, opacity:.95, fillColor:color, fillOpacity:selected?.22:.09}).addTo(group);
          polygon.bindTooltip(`${yearOf(v)} · Closed area ${index+1}<br><b>${formatArea(item.areaM2)}</b>`, {sticky:true});
          polygon.on('click',()=>selectVersion(v.version));
          const center = item.coordinates.slice(0, -1).reduce((acc,c)=>[acc[0]+c[0]/(item.coordinates.length-1),acc[1]+c[1]/(item.coordinates.length-1)],[0,0]);
          L.marker(center,{interactive:false,keyboard:false,icon:L.divIcon({className:'area-map-label',html:`<span>${formatArea(item.areaM2)}</span>`,iconSize:null})}).addTo(group);
        });
      }

      // Only the selected version shows point markers.
      // This avoids thousands of overlapping markers when many versions are visible.
      if (state.showPoints && (selected || v.type === 'node')) {
        analysis.coordinates.forEach(p => {
          const marker = L.circleMarker([p.lat, p.lon], {
            radius: selected ? 5 : 3,
            color: '#202825',
            weight: 1.2,
            fillColor: color,
            fillOpacity: .98,
            opacity: .95
          }).addTo(group);

          marker.bindPopup(
            `<b>${escapeHTML(historyLabel(v))}</b><br>Point ${p.order} · ID ${escapeHTML(p.id)}`
          );

          marker.on('click', () => selectVersion(v.version));
        });
      }

      state.layers.set(`leaflet:${v.version}`, group);
      if (state.layers.get(v.version) !== false) historyOutput.addLayer(group);
    }

    if (state.versions.length) {
      addWorkspaceLayer({
        id: 'osm-history-results',
        name: `${String(state.objectType || 'OSM').toUpperCase()} ${state.objectId || ''} History`.trim(),
        type: 'OSM History',
        source: 'OpenStreetMap',
        layer: historyOutput
      });
    }
  }

  function redrawMap() {
    if (!state.map) return;
    const managedLayers = new Set([...workspaceLayerEntries.values()].map(entry => entry.layer));

    state.map.eachLayer(layer => {
      if (layer !== state.tileLayer && !managedLayers.has(layer)) state.map.removeLayer(layer);
    });

    for (const [key] of [...state.layers]) {
      if (String(key).startsWith('leaflet:')) state.layers.delete(key);
    }

    drawLayers();
    workspaceLayerEntries.forEach(entry => {
      if (entry.visible && !state.map.hasLayer(entry.layer)) {
      prepareWorkspacePane(entry);
      entry.layer.addTo(state.map);
    }
    });
    applyWorkspaceLayerOrder();
    if (state.searchMarker) state.searchMarker.addTo(state.map);
    if (!state.searchMarker) fitVisible();
  }

  function fitVisible() {
    if (!state.map) return;

    const points = [];

    const historyVisible = workspaceLayerEntries.get('osm-history-results')?.visible !== false;
    if (historyVisible) state.versions.forEach(v => {
      if (state.layers.get(v.version) === false) return;

      const a = state.analyses.get(v.version);

      if (a) {
        a.coordinates.forEach(p => points.push([p.lat, p.lon]));
      }
    });

    let bounds = points.length ? L.latLngBounds(points) : null;
    workspaceLayerOrder.forEach(id => {
      const entry = workspaceLayerEntries.get(id);
      if (!entry || !entry.visible || typeof entry.layer.getBounds !== 'function') return;
      const layerBounds = entry.layer.getBounds();
      if (layerBounds?.isValid?.()) bounds = bounds?.isValid?.() ? bounds.extend(layerBounds) : layerBounds;
    });
    if (bounds?.isValid?.()) state.map.fitBounds(bounds.pad(.12), { maxZoom: 17 });
  }

  function selectVersion(version, redraw = true) {
    const selected = state.versions.find(v => v.version === Number(version));

    if (!selected) return;

    state.selected = selected;

    $('rightTitle').textContent = historyLabel(selected);

    renderDetails();
    renderAnalysis();
    updateSelectedLayerUI();
    populateJumpSelector();

    if (redraw) {
      redrawMap();
    }

    document.querySelectorAll('.version-row').forEach(row => {
      row.classList.toggle('selected-layer-row', Number(row.dataset.version) === selected.version);
    });
    document.querySelectorAll('.version-select').forEach(btn => {
      btn.classList.toggle('selected', btn.textContent.startsWith(historyLabel(selected)));
    });

    openRightPanel();
    window.dispatchEvent(new Event('vaanam:state-change'));
  }

  function populateJumpSelector() {
    const select = $('detailVersionSelect');
    if (!select) return;
    const current = state.selected?.version;
    select.innerHTML = '<option value="">Select a version…</option>' +
      state.versions.slice().reverse().map(x =>
        `<option value="${x.version}" ${x.version === current ? 'selected' : ''}>${escapeHTML(historyLabel(x))} · ${escapeHTML(shortDate(x.timestamp))}</option>`
      ).join('');
  }

  function updateSelectedLayerUI() {
    const v = state.selected;
    $('selectedLayerLabel').textContent = v ? `${entityLabel(v.type || state.objectType, v.id)} · ${historyLabel(v)}` : 'No layer selected';
    $('selectedLayerMeta').textContent = v ? `${formatDate(v.timestamp)} · ${v.user || 'Contributor not recorded'}` : 'Choose a version from the layer list';
  }

  function renderDetails() {
    const v = state.selected;

    if (!v) return;

    const a = state.analyses.get(v.version);

    if (!a) return;

    const color = colorFor(state.yearOrder.indexOf(yearOf(v)));

    const sourceVersionLabel = state.objectType === 'changeset'
      ? (v.sourceVersion ? `Source version ${v.sourceVersion}` : `Changed object ${v.version}`)
      : `Version ${v.version}`;
    const pointTableTitle = (v.type || state.objectType) === 'node' ? 'Node position' : 'Resolved point table';
    $('rightContent').innerHTML = `
      <div class="detail-card">
        <h3>Selected snapshot</h3>

        <div class="detail-grid">
          <div class="detail-item">
            <small>VERSION</small>
            <b>${escapeHTML(sourceVersionLabel)}</b>
          </div>

          <div class="detail-item">
            <small>YEAR</small>
            <b>${escapeHTML(yearOf(v))}</b>
          </div>

          <div class="detail-item detail-full">
            <small>EDITED</small>
            <b>${escapeHTML(formatDate(v.timestamp))}</b>
          </div>

          <div class="detail-item detail-full">
            <small>CONTRIBUTOR</small>
            <b>${escapeHTML(v.user || 'Not recorded')}</b>
          </div>

          <div class="detail-item">
            <small>POINTS FOUND</small>
            <b>${a.exact} / ${a.points.length}</b>
          </div>

          <div class="detail-item">
            <small>GAPS</small>
            <b>${a.missing}</b>
          </div>
        </div>
      </div>

      <div class="detail-card">
        <h3>${escapeHTML(entityLabel(v.type || state.objectType, v.id))} information</h3>
        <div class="tag-row"><code>${escapeHTML(v.type || state.objectType)} id</code><span>${escapeHTML(v.id)}</span></div>
        <div class="tag-row"><code>changeset</code><span>${escapeHTML(v.changeset || '—')}</span></div>
        <div class="tag-row"><code>visibility</code><span>${v.visible ? 'Visible' : 'Deleted'}</span></div>
        <div class="tag-row"><code>map colour</code><span style="color:${color}">● ${color}</span></div>
      </div>

      <div class="detail-card">
        <h3>Tags in this version</h3>
        ${
          (v.tags || []).length
            ? v.tags.map(t => `
                <div class="tag-row">
                  <code>${escapeHTML(t.k)}</code>
                  <span>${escapeHTML(t.v)}</span>
                </div>
              `).join('')
            : '<p class="fine-print">No tags recorded for this version.</p>'
        }
      </div>

      <div class="detail-card">
        <h3>${escapeHTML(pointTableTitle)}</h3>
        <p class="fine-print">Coordinates are the historical positions resolved for this snapshot. Missing positions are shown as em dashes.</p>
        <div class="coordinate-table-wrap">
          <table class="coordinate-table">
            <thead><tr><th>#</th><th>Node ID</th><th>Latitude</th><th>Longitude</th><th>Status</th></tr></thead>
            <tbody>
              ${a.points.map(p => `<tr><td>${p.order}</td><td>${escapeHTML(p.id)}</td><td>${p.lat === null ? '—' : p.lat.toFixed(7)}</td><td>${p.lon === null ? '—' : p.lon.toFixed(7)}</td><td>${escapeHTML(p.status)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

  }

  function getAnnualSnapshotBounds(rows) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    const include = point => {
      if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
      minLat = Math.min(minLat, point[0]); maxLat = Math.max(maxLat, point[0]);
      minLon = Math.min(minLon, point[1]); maxLon = Math.max(maxLon, point[1]);
    };
    rows.forEach(([, row]) => {
      (row.a?.segments || []).forEach(segment => segment.forEach(include));
      (row.a?.coordinates || []).forEach(point => include([point.lat, point.lon]));
    });
    if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;

    // Keep one shared geographic frame so year-to-year geometry sizes are comparable.
    let latSpan = Math.max(maxLat - minLat, 0.00008);
    let lonSpan = Math.max(maxLon - minLon, 0.00008);
    const frameRatio = 330 / 132;
    if (lonSpan / latSpan < frameRatio) lonSpan = latSpan * frameRatio;
    else latSpan = lonSpan / frameRatio;
    const latMid = (minLat + maxLat) / 2;
    const lonMid = (minLon + maxLon) / 2;
    const padLat = latSpan * 0.09;
    const padLon = lonSpan * 0.09;
    return {
      minLat: latMid - latSpan / 2 - padLat,
      maxLat: latMid + latSpan / 2 + padLat,
      minLon: lonMid - lonSpan / 2 - padLon,
      maxLon: lonMid + lonSpan / 2 + padLon
    };
  }

  function annualSnapshotSvg(analysis, bounds, accent, year) {
    if (!bounds) return '<div class="annual-map-empty">No historical coordinates available</div>';
    const x = lon => 15 + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 330;
    const y = lat => 12 + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * 132;
    const reducePoints = points => {
      if (!Array.isArray(points) || points.length < 1) return [];
      const step = Math.max(1, Math.ceil(points.length / 520));
      const sampled = points.filter((_, index) => index % step === 0);
      if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
      return sampled;
    };
    const makePath = (points, close = false) => {
      const valid = reducePoints(points).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!valid.length) return '';
      const d = valid.map((p, index) => `${index ? 'L' : 'M'}${x(p[1]).toFixed(2)},${y(p[0]).toFixed(2)}`).join(' ');
      return `${d}${close ? ' Z' : ''}`;
    };

    const detected = analysis?.detectedPolygons || [];
    let shapeMarkup = '';
    if (detected.length) {
      shapeMarkup = detected.map((polygon, index) => {
        const d = makePath(polygon.coordinates, true);
        return d ? `<path d="${d}" fill="${accent}" fill-opacity=".24" stroke="${accent}" stroke-width="2.1" stroke-linejoin="round" vector-effect="non-scaling-stroke"><title>${escapeHTML(year)} · enclosed area ${escapeHTML(formatArea(polygon.areaM2))}</title></path>` : '';
      }).join('');
    } else if (analysis?.segments?.length) {
      shapeMarkup = analysis.segments.map(segment => {
        const d = makePath(segment, false);
        if (!d) return '';
        const isClosed = segment.length > 3 && Math.abs(segment[0][0] - segment[segment.length - 1][0]) < 1e-7 && Math.abs(segment[0][1] - segment[segment.length - 1][1]) < 1e-7;
        return `<path d="${d}${isClosed ? ' Z' : ''}" fill="${isClosed ? accent : 'none'}" fill-opacity="${isClosed ? '.12' : '0'}" stroke="${accent}" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      }).join('');
    }

    if (!shapeMarkup && analysis?.coordinates?.length) {
      const point = analysis.coordinates[0];
      shapeMarkup = `<circle cx="${x(point.lon).toFixed(2)}" cy="${y(point.lat).toFixed(2)}" r="5.5" fill="${accent}" stroke="#fff8ef" stroke-width="2"><title>Mapped point</title></circle>`;
    }
    if (!shapeMarkup) shapeMarkup = '<text x="180" y="82" text-anchor="middle" class="annual-svg-empty">Geometry unavailable</text>';

    return `<svg class="annual-map-svg" viewBox="0 0 360 156" role="img" aria-label="${escapeHTML(year)} historical geometry preview" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="annualGrid-${escapeHTML(year).replace(/[^a-zA-Z0-9_-]/g, '')}" width="34" height="28" patternUnits="userSpaceOnUse">
          <path d="M34 0H0V28" fill="none" stroke="#b6c6b9" stroke-width=".55" opacity=".55"/>
        </pattern>
      </defs>
      <rect width="360" height="156" fill="#e4e8dd"/>
      <rect width="360" height="156" fill="url(#annualGrid-${escapeHTML(year).replace(/[^a-zA-Z0-9_-]/g, '')})"/>
      <path d="M-15 34 C35 2 62 64 112 36 S190 5 236 31 S318 62 378 20 M-15 118 C45 84 77 140 129 106 S213 86 255 112 S328 141 378 102" fill="none" stroke="#9eb9ab" stroke-width="1.15" opacity=".7"/>
      <path d="M24 -8 C45 28 88 18 111 49 S154 88 188 68 S255 42 287 77 S320 120 350 164 M-8 76 C37 65 68 86 96 74 S147 42 178 57 S230 95 273 82 S321 57 369 68" fill="none" stroke="#a6c5d1" stroke-width="1.25" opacity=".72"/>
      <path d="M-10 146 C36 126 66 146 98 126 S154 114 189 130 S260 150 292 127 S336 116 372 132" fill="none" stroke="#c6ad8f" stroke-width="1.2" opacity=".65"/>
      ${shapeMarkup}
    </svg>`;
  }

  function renderAnalysis() {
    if (!state.selected) return;
    const v = state.selected;
    const a = state.analyses.get(v.version);
    const ordered = state.versions.slice().sort((x,y)=>Date.parse(x.timestamp)-Date.parse(y.timestamp)||x.version-y.version);
    const isChangeset = state.objectType === 'changeset';
    const idx = ordered.findIndex(x=>x.version===v.version);
    const prevV = !isChangeset && idx>0 ? ordered[idx-1] : null;
    const prev = prevV ? state.analyses.get(prevV.version) : null;
    const selectedArea = a?.networkAreaM2 ?? a?.areaM2 ?? null;
    const previousArea = prev?.networkAreaM2 ?? prev?.areaM2 ?? null;
    const deltaArea = selectedArea!=null && previousArea!=null ? selectedArea-previousArea : null;
    const distance = (p1,p2) => {
      const rad = n => n*Math.PI/180, R=6371008.8;
      const dLat=rad(p2[0]-p1[0]), dLon=rad(p2[1]-p1[1]);
      const q=Math.sin(dLat/2)**2+Math.cos(rad(p1[0]))*Math.cos(rad(p2[0]))*Math.sin(dLon/2)**2;
      return 2*R*Math.asin(Math.min(1,Math.sqrt(q)));
    };
    const lineLength = analysis => (analysis?.segments||[]).reduce((sum,seg)=>{
      for(let i=1;i<seg.length;i++) sum += distance(seg[i-1],seg[i]);
      return sum;
    },0);
    const fmtLength = m => m==null || !Number.isFinite(m) ? '—' : m>=1000 ? `${(m/1000).toLocaleString(undefined,{maximumFractionDigits:3})} km` : `${m.toLocaleString(undefined,{maximumFractionDigits:1})} m`;
    const tagMap = item => Object.fromEntries((item?.tags||[]).map(t=>[t.k,t.v]));
    const compare = (before, after) => {
      const bt=tagMap(before), at=tagMap(after), keys=new Set([...Object.keys(bt),...Object.keys(at)]);
      const tagChanges=[...keys].filter(k=>bt[k]!==at[k]).map(k=>({key:k,before:bt[k],after:at[k]}));
      const oldNodes=before?.nodeIds||[], newNodes=after?.nodeIds||[];
      const oldMembers=before?.members||[], newMembers=after?.members||[];
      const oldNodeSet = new Set(oldNodes), newNodeSet = new Set(newNodes);
      const memberKey = m => `${m.type}/${m.ref}/${m.role}`;
      const oldMemberSet = new Set(oldMembers.map(memberKey)), newMemberSet = new Set(newMembers.map(memberKey));
      return {tagChanges, addedNodes:newNodes.filter(n=>!oldNodeSet.has(n)).length, removedNodes:oldNodes.filter(n=>!newNodeSet.has(n)).length,
        nodeSequenceChanged:oldNodes.join(',')!==newNodes.join(','), addedMembers:newMembers.filter(m=>!oldMemberSet.has(memberKey(m))).length,
        removedMembers:oldMembers.filter(m=>!newMemberSet.has(memberKey(m))).length,
        visibilityChanged:before?.visible!==after?.visible};
    };
    const change = prevV ? compare(prevV,v) : null;
    const allTagKeys = new Map();
    let created=0, deleted=0, restored=0, tagChangesTotal=0, geomChanges=0;
    ordered.forEach((item,i)=>{
      (item.tags||[]).forEach(t=>allTagKeys.set(t.k,(allTagKeys.get(t.k)||0)+1));
      if (isChangeset) {
        if (item.action === 'create') created++;
        else if (item.action === 'delete') deleted++;
        else if (item.action === 'modify') restored++;
      } else {
        const prior=i?ordered[i-1]:null;
        if(!prior) created++;
        else {
          const c=compare(prior,item);
          tagChangesTotal+=c.tagChanges.length;
          if(c.nodeSequenceChanged || c.addedMembers || c.removedMembers || (item.type==='node'&&(item.lat!==prior.lat||item.lon!==prior.lon))) geomChanges++;
          if(!prior.visible&&item.visible) restored++;
          if(prior.visible&&!item.visible) deleted++;
        }
      }
    });
    const years = [...new Set(ordered.map(yearOf))].sort((a,b)=>a==='Unknown year'?1:b==='Unknown year'?-1:Number(a)-Number(b));
    const byYear = new Map();
    ordered.forEach(item=>{
      const key=yearOf(item), aa=state.analyses.get(item.version);
      if(!byYear.has(key)) byYear.set(key,{v:item,a:aa,versions:0,created:0,modified:0,deleted:0,tags:0});
      const row=byYear.get(key); row.v=item; row.a=aa; row.versions++;
    });
    const annual=[...byYear.entries()].sort((x,y)=>x[0]==='Unknown year'?1:y[0]==='Unknown year'?-1:Number(x[0])-Number(y[0]));
    const annualBounds = getAnnualSnapshotBounds(annual);
    const annualColors = ['#397f72','#b77e49','#547eaa','#9671a3','#b55f58','#71914f','#3e9b9b','#9a8650','#5e7894','#ae6d88'];
    const measureLength = analysis => (analysis?.segments||[]).reduce((sum,segment)=>{
      for(let i=1;i<segment.length;i++) sum += distance(segment[i-1],segment[i]);
      return sum;
    },0);
    const annualCards=isChangeset ? '' : annual.map(([year,row],i)=>{ 
      const prevRow=i?annual[i-1][1]:null;
      const area=row.a?.networkAreaM2??row.a?.areaM2??null;
      const oldArea=prevRow?(prevRow.a?.networkAreaM2??prevRow.a?.areaM2??null):null;
      const length=measureLength(row.a), oldLength=prevRow?measureLength(prevRow.a):null;
      let delta=null, deltaText='First available snapshot', deltaKind='neutral';
      if(area!=null && oldArea!=null){ delta=area-oldArea; deltaText=`${delta>0?'↑':delta<0?'↓':'→'} ${delta>0?'+':''}${formatArea(delta)}`; deltaKind=delta>0?'up':delta<0?'down':'neutral'; }
      else if(area==null && oldArea==null && prevRow && Number.isFinite(length) && Number.isFinite(oldLength) && (length>0 || oldLength>0)){
        delta=length-oldLength; deltaText=`${delta>0?'↑':delta<0?'↓':'→'} ${delta>0?'+':''}${fmtLength(delta)}`; deltaKind=delta>0?'up':delta<0?'down':'neutral';
      }
      const accent=annualColors[i%annualColors.length];
      const type=(row.v.type||state.objectType||'object').toUpperCase();
      const metric=area!=null
        ? `<span class="annual-metric-label">ENCLOSED AREA</span><strong>${formatArea(area)}</strong>`
        : length>0
          ? `<span class="annual-metric-label">LINE LENGTH</span><strong>${fmtLength(length)}</strong>`
          : `<span class="annual-metric-label">GEOMETRY</span><strong>${row.a?.exact?`${row.a.exact} positions`:'Not measurable'}</strong>`;
      const secondary=area!=null && length>0 ? `<span class="annual-secondary-metric">Line length · ${fmtLength(length)}</span>` : `<span class="annual-secondary-metric">${row.a?.exact??0} positions · ${row.a?.missing??0} missing</span>`;
      const snapshotDate=new Date(row.v.timestamp);
      const dateLabel=Number.isFinite(snapshotDate.getTime())?snapshotDate.toISOString().slice(0,10):'Date not recorded';
      const mapPreview=annualSnapshotSvg(row.a,annualBounds,accent,year);
      const safeYear=escapeHTML(year);
      return `<article class="annual-snapshot" style="--snapshot-accent:${accent}">
        <button type="button" class="annual-preview-button analysis-jump" data-version="${row.v.version}" aria-label="Inspect ${safeYear} snapshot">
          ${mapPreview}
          <span class="annual-year-chip">${safeYear}</span>
          <span class="annual-map-label">${area!=null?`AREA · ${escapeHTML(formatArea(area))}`:length>0?`LENGTH · ${escapeHTML(fmtLength(length))}`:'GEOMETRY PREVIEW'}</span>
        </button>
        <div class="annual-snapshot-body">
          <div class="annual-snapshot-heading"><div><span class="annual-card-kicker">YEAR SNAPSHOT</span><h3>${safeYear}</h3></div><span class="annual-change-chip ${deltaKind}">${escapeHTML(deltaText)}</span></div>
          <div class="annual-snapshot-meta"><span>${escapeHTML(type)}</span><span>VERSION ${row.v.version}</span><span>${row.versions} ${row.versions===1?'VERSION':'VERSIONS'}</span></div>
          <div class="annual-measure">${metric}${secondary}</div>
          <div class="annual-snapshot-footer"><span>${escapeHTML(dateLabel)}</span><button type="button" class="analysis-jump" data-version="${row.v.version}">Inspect version ↗</button></div>
        </div>
      </article>`;
    }).join('');
    const tagRows=(change?.tagChanges||[]).map(t=>`<tr><td><code>${escapeHTML(t.key)}</code></td><td>${t.before==null?'—':escapeHTML(t.before)}</td><td>${t.after==null?'—':escapeHTML(t.after)}</td><td>${t.before==null?'Added':t.after==null?'Removed':'Modified'}</td></tr>`).join('');
    const typeCounts = {node:0,way:0,relation:0};
    ordered.forEach(item=>{typeCounts[item.type||state.objectType]=(typeCounts[item.type||state.objectType]||0)+1;});
    const boundary = (v.tags||[]).some(t=>t.k==='boundary'||t.k==='admin_level'||t.k==='border_type') || (v.members||[]).some(m=>m.role==='outer'||m.role==='inner');
    const lengthNow=lineLength(a), lengthPrev=lineLength(prev), lengthDelta=prev?lengthNow-lengthPrev:null;
    $('analysisContent').innerHTML = `
      <div class="analysis-hero"><div><p class="eyebrow">GEOSPATIAL CHANGE INTELLIGENCE</p><h2>Historical analysis</h2><p>Evidence-led measurements from the loaded OSM history. Results describe mapped data, not necessarily real-world change.</p></div><span class="analysis-live">● ${a?'DATA READY':'PREPARING'}</span></div>
      <div class="analysis-kpi-grid">
        <div class="analysis-kpi"><small>${isChangeset?'OBJECTS IN CHANGESET':'OBJECT VERSIONS'}</small><strong>${ordered.length}</strong><span>${isChangeset?'Independent edit-batch objects':`${escapeHTML(v.type||state.objectType)} ${escapeHTML(v.id||state.objectId||'')}`}</span></div>
        <div class="analysis-kpi"><small>YEARS COVERED</small><strong>${years.length}</strong><span>${years.length?`${years[0]}–${years[years.length-1]}`:'No dates'}</span></div>
        <div class="analysis-kpi"><small>${isChangeset?'CREATE / MODIFY / DELETE':'GEOMETRY CHANGES'}</small><strong>${isChangeset?`${created} / ${restored} / ${deleted}`:geomChanges}</strong><span>${isChangeset?'Changeset operation counts':'Version transitions checked'}</span></div>
        <div class="analysis-kpi"><small>TAG CHANGES</small><strong>${isChangeset?'—':tagChangesTotal}</strong><span>${isChangeset?'Not compared across different objects':'Key/value transitions'}</span></div>
      </div>
      <details class="analysis-section" open><summary><span>01 · Object and data readiness</span><span class="section-subtitle">Inventory & provenance</span></summary>
        <div class="detail-grid">
          <div class="detail-item"><small>OBJECT TYPE</small><b>${escapeHTML(v.type||state.objectType)}</b></div>
          <div class="detail-item"><small>OBJECT ID</small><b>${escapeHTML(v.id||state.objectId||'—')}</b></div>
          <div class="detail-item"><small>NODE VERSIONS</small><b>${typeCounts.node||0}</b></div>
          <div class="detail-item"><small>WAY VERSIONS</small><b>${typeCounts.way||0}</b></div>
          <div class="detail-item"><small>RELATION VERSIONS</small><b>${typeCounts.relation||0}</b></div>
          <div class="detail-item"><small>CONTRIBUTORS PRESENT</small><b>${new Set(ordered.map(x=>x.user).filter(Boolean)).size}</b></div>
          <div class="detail-item"><small>CHANGESets REFERENCED</small><b>${new Set(ordered.map(x=>x.changeset).filter(Boolean)).size}</b></div>
          <div class="detail-item"><small>ADMIN / BOUNDARY TAGS</small><b>${boundary?'Present':'Not detected'}</b></div>
        </div>
        <p class="fine-print">Source: loaded OSM history XML or OpenStreetMap API response. Only versions available in this loaded history are counted; this is not a complete regional OSM inventory.</p>
      </details>
      <details class="analysis-section" open><summary><span>02 · Geometry and footprint</span><span class="section-subtitle">Measured from available coordinates</span></summary>
        <div class="detail-grid">
          <div class="detail-item"><small>DETECTED CLOSED AREAS</small><b>${a?.detectedPolygons?.length||0}</b></div>
          <div class="detail-item"><small>ENCLOSED AREA</small><b>${selectedArea==null?'Not defined':formatArea(selectedArea)}</b></div>
          <div class="detail-item"><small>LINE LENGTH</small><b>${fmtLength(lengthNow)}</b></div>
          <div class="detail-item"><small>LENGTH Δ VS PREVIOUS</small><b>${lengthDelta==null?'—':`${lengthDelta>0?'+':''}${fmtLength(lengthDelta)}`}</b></div>
          <div class="detail-item"><small>POSITIONS FOUND</small><b>${a?.exact||0}</b></div>
          <div class="detail-item"><small>POSITIONS MISSING</small><b>${a?.missing||0}</b></div>
        </div>
        <div class="area-stats"><div><small>NET AREA Δ VS PREVIOUS VERSION</small><b>${deltaArea==null?'—':`${deltaArea>0?'+':''}${formatArea(deltaArea)}`}</b></div><div><small>GEOMETRY STATUS</small><b>${a?.missing?'Incomplete':selectedArea!=null?'Closed ring detected':'Linear / point geometry'}</b></div></div>
        <p class="fine-print">${isChangeset ? 'Measurements in this section refer only to the selected object in the changeset, not to the combined changeset footprint.' : 'Length uses a spherical-earth haversine calculation over available line segments. Area is shown only when the existing geometry engine detects closed linework. Net area difference is not the same as the full changed footprint; no unobserved geometry is inferred.'}</p>
        <label class="analysis-toggle"><input id="areaOverlayToggle" type="checkbox" ${state.showAreaOverlay?'checked':''}> Show detected polygon fills and area labels on map</label>
      </details>
      <details class="analysis-section" open><summary><span>${isChangeset?'03 · Changeset operation':'03 · Version-to-version change log'}</span><span class="section-subtitle">${isChangeset?'Independent objects':`v${prevV?.version??'—'} → v${v.version}`}</span></summary>
        ${isChangeset ? `<div class="analysis-empty-note">This file is a changeset download: each row is a different OSM object changed in one edit batch. Comparing adjacent rows would create false tag and geometry changes, so cross-object comparison is disabled. Selected object operation: <b>${escapeHTML(v.action || (v.visible ? 'modify' : 'delete'))}</b>.</div>` : `<div class="analysis-kpi-grid compact-kpis">
          <div class="analysis-kpi"><small>NODES ADDED</small><strong>${change?.addedNodes??'—'}</strong></div>
          <div class="analysis-kpi"><small>NODES REMOVED</small><strong>${change?.removedNodes??'—'}</strong></div>
          <div class="analysis-kpi"><small>MEMBERS ADDED</small><strong>${change?.addedMembers??'—'}</strong></div>
          <div class="analysis-kpi"><small>MEMBERS REMOVED</small><strong>${change?.removedMembers??'—'}</strong></div>
        </div>
        <p class="fine-print">${prevV?`Previous timestamp: ${escapeHTML(prevV.timestamp||'not supplied')}. Selected timestamp: ${escapeHTML(v.timestamp||'not supplied')}.`: 'This is the first available version in the loaded sequence; no prior transition can be calculated.'} ${change?.visibilityChanged?'Visibility changed (created/deleted/restored status may be relevant).':''}</p>
        ${tagRows?`<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>Tag key</th><th>Previous</th><th>Selected</th><th>Change</th></tr></thead><tbody>${tagRows}</tbody></table></div>`:'<div class="analysis-empty-note">No tag key/value differences detected for this transition, or no prior version is available.</div>'}`}
      </details>
      <details class="analysis-section annual-section" open><summary><span>${isChangeset?'04 · Objects by edit year':'04 · Year-by-year geometry'}</span><span class="section-subtitle">${annual.length} yearly snapshots</span></summary>
        <div class="analysis-snapshot-grid">${isChangeset ? '<div class="analysis-empty-note">A changeset groups independent objects from one edit batch. A year-by-year geometry comparison is therefore not applicable.</div>' : annualCards||'<div class="analysis-empty-note">No dated versions are available in this history.</div>'}</div>
        <p class="fine-print">${isChangeset ? 'Use the OSM History version timeline to inspect each changed object individually. The change operation is shown beside its object ID.' : 'Each tile shows the latest loaded version for that year, drawn in one shared map frame for visual comparison. Closed geometry is measured as area; open ways are reported by line length. Missing or incomplete geometry is never estimated.'}</p>
      </details>
      <details class="analysis-section"><summary><span>05 · Tag intelligence</span><span class="section-subtitle">${allTagKeys.size} distinct keys observed</span></summary>
        <div class="tag-cloud">${[...allTagKeys.entries()].sort((x,y)=>y[1]-x[1]).map(([key,count])=>`<span class="tag-pill"><code>${escapeHTML(key)}</code><b>${count}</b></span>`).join('')||'<span class="fine-print">No tags in loaded versions.</span>'}</div>
        <p class="fine-print">Counts represent appearances of a tag key across loaded versions, not a count of real-world features.</p>
      </details>
      <details class="analysis-section"><summary><span>06 · Export and report</span><span class="section-subtitle">Portable outputs</span></summary>
        <div class="analysis-export-actions"><button type="button" class="button button-primary" id="analysisGeoJSON">Export GeoJSON</button><button type="button" class="button button-quiet" id="analysisCSV">Export selected-version point CSV</button><button type="button" class="button button-quiet" id="analysisKML">Export KML</button><button type="button" class="button button-quiet" id="analysisReport">Print / Save PDF report</button></div>
        <p class="fine-print">The point CSV contains the selected version only. The PDF option opens the browser print dialog; choose “Save as PDF”. Export geometry is limited to what was successfully reconstructed in the browser.</p>
      </details>`;
    const overlayHandler=e=>{state.showAreaOverlay=e.target.checked;redrawMap();renderAnalysis();};
    $('areaOverlayToggle')?.addEventListener('change',overlayHandler);
    $('analysisContent').querySelectorAll('.analysis-jump').forEach(btn=>btn.addEventListener('click',()=>selectVersion(Number(btn.dataset.version))));
    $('analysisGeoJSON')?.addEventListener('click',()=>exportGeoJSON(true));
    $('analysisCSV')?.addEventListener('click',()=>exportCSV());
    $('analysisKML')?.addEventListener('click',exportKML);
    $('analysisReport')?.addEventListener('click',()=>window.print());
  }

  function exportKML() {
    if (!state.versions.length) return;
    const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
    const coordinateText = coords => coords.map(p => `${p[0]},${p[1]},0`).join(' ');
    const ringKml = (ring, tag) => `<${tag}><LinearRing><coordinates>${coordinateText(ring)}</coordinates></LinearRing></${tag}>`;
    const geometryKml = geometry => {
      if (!geometry) return '';
      if (geometry.type === 'Point') {
        return `<Point><coordinates>${geometry.coordinates[0]},${geometry.coordinates[1]},0</coordinates></Point>`;
      }
      if (geometry.type === 'LineString') {
        return `<LineString><tessellate>1</tessellate><coordinates>${coordinateText(geometry.coordinates)}</coordinates></LineString>`;
      }
      if (geometry.type === 'MultiLineString') {
        return `<MultiGeometry>${geometry.coordinates.map(line => `<LineString><tessellate>1</tessellate><coordinates>${coordinateText(line)}</coordinates></LineString>`).join('')}</MultiGeometry>`;
      }
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
      if (!polygons.length) return '';
      const parts = polygons.map(rings => {
        const [outer, ...holes] = rings;
        if (!outer?.length) return '';
        return `<Polygon><tessellate>1</tessellate>${ringKml(outer, 'outerBoundaryIs')}${holes.map(r => ringKml(r, 'innerBoundaryIs')).join('')}</Polygon>`;
      }).filter(Boolean);
      return parts.length === 1 ? parts[0] : parts.length ? `<MultiGeometry>${parts.join('')}</MultiGeometry>` : '';
    };
    const placemarks = state.versions.map(v => {
      const feature = makeFeature(v);
      const geometry = geometryKml(feature?.geometry);
      if (!geometry) return '';
      const timeMs = Date.parse(v.timestamp || '');
      const timeStamp = Number.isFinite(timeMs) ? `<TimeStamp><when>${esc(v.timestamp)}</when></TimeStamp>` : '';
      return `<Placemark><name>${esc(`${v.type||state.objectType} ${v.id} v${v.sourceVersion||v.version}`)}</name><description>${esc(`Timestamp: ${v.timestamp}; user: ${v.user}; changeset: ${v.changeset}; © OpenStreetMap contributors; Open Data Commons Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/`)}</description>${timeStamp}${geometry}</Placemark>`;
    }).join('');
    downloadBlob(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(`OSM ${state.objectType} ${state.objectId} history`)}</name><description>${esc('Contains information from OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright · https://opendatacommons.org/licenses/odbl/1-0/')}</description>${placemarks}</Document></kml>`,'application/vnd.google-earth.kml+xml',`${state.objectType}-${state.objectId}-history.kml`);
    toast('KML export created with available point, line and polygon geometry.');
  }

  function mountAnalysisPanels() {
    const content = $('workspaceModalContent');
    if (!content) return;
    ['osmPanel', 'changePanel', 'lstPanel', 'basemapPanel'].forEach(id => {
      const panel = $(id);
      if (panel && panel.parentElement !== content) content.append(panel);
    });
  }

  function openWorkspaceModal(panelName = state.activePanel || 'addData') {
    const modal = $('workspaceModal');
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    showPanel(panelName, false);
    window.requestAnimationFrame(() => state.map?.invalidateSize({ pan: false }));
  }

  function closeWorkspaceModal() {
    const modal = $('workspaceModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    closeAnalysisDropdown();
    window.requestAnimationFrame(() => state.map?.invalidateSize({ pan: false }));
  }

  function showPanel(name, openModal = true) {
    const panels = {
      addData: 'addDataPanel', osm: 'osmPanel', change: 'changePanel', lst: 'lstPanel', basemap: 'basemapPanel'
    };
    if (!panels[name]) name = 'addData';
    state.activePanel = name;
    Object.entries(panels).forEach(([key, id]) => {
      const panel = $(id);
      if (panel) panel.hidden = key !== name;
    });
    document.querySelectorAll('[data-open-panel]').forEach(button => {
      const active = button.dataset.openPanel === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('analysisMenuBtn')?.classList.toggle('active', ['osm', 'change', 'lst'].includes(name));
    document.querySelectorAll('[data-analysis-panel]').forEach(button => {
      const active = button.dataset.analysisPanel === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const titles = {
      addData: 'Add Data', osm: 'OSM History', change: 'Change Detection',
      lst: 'Land Surface Temperature', basemap: 'Base Map'
    };
    $('workspaceModalTitle').textContent = titles[name] || 'NEELVAAN Workspace';
    closeAnalysisDropdown();
    if (openModal) {
      const modal = $('workspaceModal');
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
    }
    window.dispatchEvent(new Event('vaanam:state-change'));
    if (state.map) window.requestAnimationFrame(() => state.map?.invalidateSize({ pan: false }));
  }

  function openRightPanel() {
    if (state.activePanel !== 'osm') showPanel('osm');
  }

  function togglePoints() {
    state.showPoints = !state.showPoints;

    $('pointsBtn').classList.toggle('active', state.showPoints);
    $('pointsBtn').title = state.showPoints ? 'Hide points' : 'Show points';
    $('pointsBtn').setAttribute('aria-pressed', String(state.showPoints));

    redrawMap();
  }

  function showAll(visible) {
    state.versions.forEach(v => {
      state.layers.set(v.version, visible);
    });

    renderLayers();
    redrawMap();
  }

  function makeFeature(version) {
    const a = state.analyses.get(version.version);
    if (!a) return null;
    const objectType = version.type || state.objectType;
    let geometry = null;
    if (objectType === 'node') {
      if (a.coordinates[0]) geometry = { type: 'Point', coordinates: [a.coordinates[0].lon, a.coordinates[0].lat] };
    } else if (a.detectedPolygons?.length && a.topologyComplete !== false) {
      // GeoJSON RFC 7946: exterior rings counter-clockwise, interior rings clockwise.
      const orientRing = (ring, isOuter) => {
        const coordinates = ring.map(([lat, lon]) => [lon, lat]);
        let signedArea = 0;
        for (let i = 0; i < coordinates.length - 1; i++) {
          const [x1, y1] = coordinates[i], [x2, y2] = coordinates[i + 1];
          signedArea += x1 * y2 - x2 * y1;
        }
        const isCounterClockwise = signedArea > 0;
        return isCounterClockwise === isOuter ? coordinates : coordinates.reverse();
      };
      const polygons = a.detectedPolygons.map(poly => [
        orientRing(poly.coordinates, true),
        ...(poly.holes || []).map(ring => orientRing(ring, false))
      ]);
      geometry = polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons };
    } else if (a.segments.length === 1) {
      geometry = { type: 'LineString', coordinates: a.segments[0].map(([lat, lon]) => [lon, lat]) };
    } else if (a.segments.length > 1) {
      geometry = { type: 'MultiLineString', coordinates: a.segments.map(seg => seg.map(([lat, lon]) => [lon, lat])) };
    }
    return {
      type: 'Feature',
      geometry,
      properties: {
        object_type: objectType,
        object_id: version.id,
        version: version.sourceVersion || version.version,
        timestamp: version.timestamp,
        user: version.user,
        changeset: version.changeset,
        visible: version.visible,
        point_count: a.points.length,
        points_found: a.exact,
        points_missing: a.missing,
        area_m2: Number.isFinite(a.networkAreaM2) ? a.networkAreaM2 : null,
        topology_complete: a.topologyComplete,
        tags: tagsObject(version.tags),
        data_source: 'OpenStreetMap contributors via OpenStreetMap API',
        attribution: '© OpenStreetMap contributors',
        licence: 'Open Database License (ODbL) 1.0',
        licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/'
      }
    };
  }

  function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;

    document.body.append(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportGeoJSON(all) {
    if (!state.selected) return;

    const versions = all ? state.versions : [state.selected];
    const features = versions.map(makeFeature).filter(Boolean);

    const output = {
      type: 'FeatureCollection',
      name: `OSM ${state.objectType} ${state.objectId} history`,
      generator: 'NEELVAAN OSM History',
      source: 'OpenStreetMap contributors via OpenStreetMap API',
      attribution: '© OpenStreetMap contributors',
      license: 'Open Database License (ODbL) 1.0',
      license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
      source_url: 'https://www.openstreetmap.org/copyright',
      features
    };

    downloadBlob(
      JSON.stringify(output, null, 2),
      'application/geo+json',
      `${state.objectType}-${state.objectId}-${all ? 'all-versions' : `v${state.selected.version}`}.geojson`
    );

    toast(`Exported ${features.length} ${features.length === 1 ? 'version' : 'versions'} as GeoJSON.`);
  }

  function exportCSV() {
    if (!state.versions.length) return;

    const rows = [[
      'object_type',
      'object_id',
      'object_version',
      'timestamp',
      'user',
      'point_order',
      'node_id',
      'latitude',
      'longitude',
      'position_status',
      'data_source',
      'attribution',
      'licence',
      'licence_url'
    ]];

    [state.selected].filter(Boolean).forEach(v => {
      const a = state.analyses.get(v.version);

      if (!a) return;

      a.points.forEach(p => {
        rows.push([
          v.type || state.objectType,
          v.id,
          v.sourceVersion || v.version,
          v.timestamp,
          v.user,
          p.order,
          p.id,
          p.lat ?? '',
          p.lon ?? '',
          p.status,
          'OpenStreetMap contributors via OpenStreetMap API',
          '© OpenStreetMap contributors',
          'Open Database License (ODbL) 1.0',
          'https://opendatacommons.org/licenses/odbl/1-0/'
        ]);
      });
    });

    const csv = rows.map(row =>
      row.map(value => {
        let s = String(value ?? '');

        if (/^[\s]*[=+@]/.test(s) || /^[\s]*-(?=[A-Za-z])/.test(s)) {
          s = "'" + s;
        }

        return `"${s.replace(/"/g, '""')}"`;
      }).join(',')
    ).join('\r\n');

    downloadBlob(
      '\ufeff' + csv,
      'text/csv;charset=utf-8',
      `${state.objectType}-${state.objectId}-point-audit.csv`
    );

    toast('Point audit CSV exported.');
  }

  function addGeoJSONFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast('GeoJSON is larger than 30 MB.'); return; }
    if (!/\.(geojson|json)$/i.test(file.name) && !/json|geo\+json/i.test(file.type || '')) {
      toast('Choose a .geojson or .json file.');
      return;
    }
    $('geojsonStatus').textContent = `Reading ${file.name}…`;
    file.text().then(raw => {
      let data;
      try { data = JSON.parse(raw); }
      catch (_) { throw new Error('This file is not valid JSON.'); }
      if (!data || !['FeatureCollection', 'Feature', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(data.type)) {
        throw new Error('Expected a GeoJSON Feature, FeatureCollection or geometry.');
      }
      const layer = L.geoJSON(data, {
        style: feature => ({ color: '#d9b08c', weight: 2.4, fillColor: '#65b7a6', fillOpacity: .18 }),
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color: '#243b32', weight: 1.5, fillColor: '#f0bb8c', fillOpacity: 1 })
      });
      const features = data.type === 'FeatureCollection' ? data.features.length : 1;
      const name = file.name.replace(/\.(geojson|json)$/i, '') || 'GeoJSON data';
      addWorkspaceLayer({ id: `geojson-${Date.now()}`, name, type: 'GeoJSON', source: `${features.toLocaleString()} ${features === 1 ? 'feature' : 'features'}`, layer });
      const bounds = layer.getBounds?.();
      if (bounds?.isValid?.()) state.map.fitBounds(bounds.pad(.08), { maxZoom: 16, animate: true });
      $('geojsonStatus').textContent = `${features.toLocaleString()} ${features === 1 ? 'feature' : 'features'} imported as “${name}” and added to Map Content.`;
      toast(`${name} added to Map Content.`);
      window.dispatchEvent(new CustomEvent('vaanam:workspace-result', { detail: { kind: 'geojson', label: name, summary: { features } } }));
      closeWorkspaceModal();
    }).catch(error => {
      $('geojsonStatus').textContent = error.message || 'Could not import this GeoJSON file.';
      toast(error.message || 'Could not import this GeoJSON file.');
    });
  }

  function setMapContentExpanded(expanded) {
    mapContentExpanded = Boolean(expanded);
    document.body.classList.toggle('map-content-collapsed', !mapContentExpanded);
    const button = $('mapContentCollapseBtn');
    if (button) {
      button.setAttribute('aria-expanded', String(mapContentExpanded));
      button.setAttribute('aria-label', mapContentExpanded ? 'Collapse Map Content' : 'Expand Map Content');
      button.title = mapContentExpanded ? 'Collapse Map Content' : 'Expand Map Content';
    }
    window.requestAnimationFrame(() => state.map?.invalidateSize({ pan: false }));
  }

  function initMapContentResize() {
    const divider = $('sidebarResizer');
    const shell = document.querySelector('.app-shell');
    if (!divider || !shell) return;
    const clamp = value => Math.max(210, Math.min(520, value));
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    divider.addEventListener('pointerdown', event => {
      if (event.button !== 0 || document.body.classList.contains('map-content-collapsed')) return;
      dragging = true;
      startX = event.clientX;
      startWidth = document.querySelector('.left-panel').getBoundingClientRect().width;
      divider.classList.add('dragging');
      divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    divider.addEventListener('pointermove', event => {
      if (!dragging) return;
      const width = clamp(startWidth + event.clientX - startX);
      document.documentElement.style.setProperty('--map-content-width', `${width}px`);
      divider.setAttribute('aria-valuenow', String(Math.round(width)));
      state.map?.invalidateSize({ pan: false });
    });
    const stop = () => { dragging = false; divider.classList.remove('dragging'); };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
    divider.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const current = document.querySelector('.left-panel').getBoundingClientRect().width;
      const width = clamp(current + (event.key === 'ArrowRight' ? 16 : -16));
      document.documentElement.style.setProperty('--map-content-width', `${width}px`);
      divider.setAttribute('aria-valuenow', String(Math.round(width)));
      state.map?.invalidateSize({ pan: false });
    });
  }

  function initializeGoogleDriveSignIn() {
    const button = $('googleLoginBtn');
    const status = $('googleLoginStatus');
    if (!button) return;
    const clientId = String(window.NEELVAAN_CONFIG?.googleClientId || '').trim();
    const showSetupMessage = () => {
      button.addEventListener('click', () => toast('Google sign-in setup is required: add your Web OAuth Client ID in google-config.js, enable Google Drive API and authorize your website domain.'));
      button.title = 'Add a Google Web OAuth Client ID in google-config.js to enable sign-in.';
    };
    if (!clientId || !clientId.endsWith('.apps.googleusercontent.com')) {
      showSetupMessage();
      return;
    }
    const setup = () => {
      if (!window.google?.accounts?.oauth2 || googleDriveTokenClient) return;
      googleDriveTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
        include_granted_scopes: true,
        callback: async response => {
          if (response.error || !response.access_token) {
            toast(response.error_description || response.error || 'Google sign-in did not complete. Please try again.');
            return;
          }
          googleDriveAccessToken = response.access_token;
          googleDriveTokenExpiry = Date.now() + Math.max(0, Number(response.expires_in || 0)) * 1000;
          button.disabled = true;
          button.querySelector('span:last-child').textContent = 'Connecting…';
          try {
            const profileResponse = await fetchWithTimeout('https://openidconnect.googleapis.com/v1/userinfo', {
              headers: { Authorization: `Bearer ${googleDriveAccessToken}` }
            }, 12000);
            if (!profileResponse.ok) throw new Error(`Google account lookup returned ${profileResponse.status}.`);
            const profile = await profileResponse.json();
            const email = String(profile.email || '').trim();
            button.querySelector('span:last-child').textContent = email || 'Google connected';
            button.title = `Connected as ${email || 'Google account'}. Drive access is limited to files created or opened by NEELVAAN.`;
            button.setAttribute('aria-label', `Google account connected: ${email || 'Google account'}`);
            status.hidden = false;
            status.textContent = 'Connected';
            toast(`Google account connected${email ? `: ${email}` : ''}. NEELVAAN has limited app-file access in Drive.`);
          } catch (error) {
            googleDriveAccessToken = '';
            googleDriveTokenExpiry = 0;
            button.querySelector('span:last-child').textContent = 'Login with Google';
            toast(error.message || 'Could not verify the Google account. Please try again.');
          } finally {
            button.disabled = false;
          }
        },
        error_callback: error => {
          toast(error?.message || 'Google sign-in popup could not be opened. Allow popups and try again.');
        }
      });
      button.addEventListener('click', () => {
        if (googleDriveAccessToken && googleDriveTokenExpiry > Date.now() + 30000) {
          toast('Your Google Drive connection is already active in this tab.');
          return;
        }
        googleDriveTokenClient.requestAccessToken({ prompt: 'select_account' });
      });
    };
    if (window.google?.accounts?.oauth2) setup();
    else {
      const script = $('googleIdentityScript');
      if (script) script.addEventListener('load', setup, { once: true });
      window.addEventListener('load', setup, { once: true });
    }
  }

  function initWorkspaceInteractions() {
    mountAnalysisPanels();
    renderBasemapGallery();
    bindMapFeatureDialogs();
    $('workspaceModalClose')?.addEventListener('click', closeWorkspaceModal);
    $('workspaceModal')?.querySelector('.workspace-modal-backdrop')?.addEventListener('click', closeWorkspaceModal);
    initializeGoogleDriveSignIn();
    document.querySelectorAll('[data-open-panel]').forEach(button => button.addEventListener('click', () => openWorkspaceModal(button.dataset.openPanel)));
    $('analysisMenuBtn')?.addEventListener('click', () => {
      const menu = $('analysisMenu');
      const open = menu.hidden;
      menu.hidden = !open;
      $('analysisMenuBtn').setAttribute('aria-expanded', String(open));
      $('analysisMenuBtn').classList.toggle('menu-open', open);
    });
    document.querySelectorAll('[data-analysis-panel]').forEach(button => button.addEventListener('click', () => openWorkspaceModal(button.dataset.analysisPanel)));
    document.addEventListener('click', event => {
      if (!event.target.closest('.analysis-menu-wrap')) closeAnalysisDropdown();
      if (event.target.closest('.workspace-layer-menu, .workspace-layer-menu-button')) return;
      closeWorkspaceLayerMenus();
    });
    window.addEventListener('resize', () => {
      closeWorkspaceLayerMenus();
    });
    document.addEventListener('scroll', () => {
      closeWorkspaceLayerMenus();
    }, true);
    $('mapContentCollapseBtn')?.addEventListener('click', () => {
      measureAutoCollapsedMapContent = false;
      setMapContentExpanded(!mapContentExpanded);
    });
    $('geojsonBrowseBtn')?.addEventListener('click', () => $('geojsonFile').click());
    $('geojsonFile')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) addGeoJSONFile(file);
      event.target.value = '';
    });
    const dropzone = $('geojsonDropzone');
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('drag-over'); }));
      ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('drag-over'); }));
      dropzone.addEventListener('drop', event => addGeoJSONFile([...(event.dataTransfer?.files || [])].find(file => /\.(geojson|json)$/i.test(file.name))));
    }
    initMapContentResize();
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!$('placeMarkDialog').hidden) { closePlaceMarkDialog(); return; }
      if (!$('geometryDialog').hidden) { closeGeometryDialog(true); return; }
      if (!$('measurePanel').hidden) { closeMeasurePanel(true); return; }
      if (!$('layerEditDialog').hidden) { closeLayerEditDialog(); return; }
      if (!$('analysisMenu').hidden) {
        closeAnalysisDropdown();
        $('analysisMenuBtn')?.focus();
        return;
      }
      if (!$('workspaceModal').hidden) closeWorkspaceModal();
    });
  }

  // OSM History XML import and responsive panel controls.

  $('osmImportBtn').addEventListener('click', () => $('xmlFile').click());

  $('xmlFile').addEventListener('change', e => {
    const file = e.target.files?.[0];

    if (file) {
      objectLookupGeneration++;
      $('objectSearchBtn').disabled = false;
      $('objectSearchBtn').textContent = 'Load history';
      handleFile(file);
      e.target.value = '';
    }
  });

  $('detailVersionSelect').addEventListener('change', e => {
    if (e.target.value) selectVersion(Number(e.target.value));
  });

  async function searchPlaceOrCoordinates(query) {
    // A newer submission (including coordinates or an empty query) supersedes
    // any outstanding Photon request so stale results cannot move the map.
    const searchGeneration = ++placeSearchGeneration;
    const input = $('placeSearchInput');
    const value = String(query || '').trim();
    if (!value) { toast('Enter a place name or latitude, longitude.'); return; }
    if (!state.map) { toast('The map is not available yet.'); return; }

    // Coordinate input is local and does not call a geocoding provider.
    const pair = value.match(/^\s*([+-]?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*$/);
    if (pair) {
      const lat = Number(pair[1]);
      const lon = Number(pair[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        toast('Coordinates are out of range. Use latitude −90 to 90 and longitude −180 to 180.');
        return;
      }
      showPlaceResult(lat, lon, `${lat.toFixed(6)}, ${lon.toFixed(6)}`, 15);
      return;
    }

    input?.setAttribute('aria-busy', 'true');
    try {
      // Photon is used only for an explicit user-submitted search (never autocomplete).
      // The public demo has fair-use limits and no uptime guarantee; throttle each browser to <=1 req/sec.
      const wait = Math.max(0, 1000 - (Date.now() - state.lastGeocodeAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (searchGeneration !== placeSearchGeneration) return;
      state.lastGeocodeAt = Date.now();
      const url = `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(value)}`;
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/geo+json' }, referrerPolicy: 'strict-origin-when-cross-origin' }, 15000);
      if (!response.ok) throw new Error(`Place search returned HTTP ${response.status}. Try coordinates or retry later.`);
      const data = await response.json();
      if (searchGeneration !== placeSearchGeneration) return;
      const results = Array.isArray(data?.features) ? data.features : [];
      if (!results.length) throw new Error(`No place found for “${value}”. Try a more specific place name or latitude, longitude.`);
      const result = results[0];
      const lon = Number(result.geometry?.coordinates?.[0]);
      const lat = Number(result.geometry?.coordinates?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('The place search returned invalid coordinates.');
      const props = result.properties || {};
      const label = [props.name, props.street, props.city || props.locality, props.state, props.country]
        .filter((part, index, array) => part && array.indexOf(part) === index)
        .join(', ') || props.label || value;
      if (searchGeneration === placeSearchGeneration) showPlaceResult(lat, lon, label, 14);
    } catch (error) {
      if (searchGeneration === placeSearchGeneration) toast(error.message || 'Could not search for this place.');
    } finally {
      if (searchGeneration === placeSearchGeneration) {
        input?.removeAttribute('aria-busy');
      }
    }
  }

  function showPlaceResult(lat, lon, label, zoom) {
    if (state.searchMarker && state.map) state.map.removeLayer(state.searchMarker);
    state.searchMarker = L.marker([lat, lon], { title: label })
      .bindPopup(`<strong>${escapeHTML(label)}</strong><br><small>Coordinates: ${lat.toFixed(6)}, ${lon.toFixed(6)}</small>`);
    state.searchMarker.addTo(state.map).openPopup();
    state.map.setView([lat, lon], zoom, { animate: true, duration: 0.6 });
  }

  $('placeSearchForm').addEventListener('submit', event => {
    event.preventDefault();
    searchPlaceOrCoordinates($('placeSearchInput').value);
  });

  $('placeSearchInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') $('placeSearchInput').blur();
  });

  $('objectSearchBtn').addEventListener('click', async () => {
    const type = $('objectSearchType').value;
    const id = $('objectSearchId').value.trim();
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) {
      $('objectSearchId').setCustomValidity('Enter a numeric OpenStreetMap ID.');
      $('objectSearchId').reportValidity();
      toast('Enter a valid numeric OSM ID.');
      return;
    }
    $('objectSearchId').setCustomValidity('');
    const lookupGeneration = ++objectLookupGeneration;
    const button = $('objectSearchBtn');
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = 'Loading…';
    try {
      const endpoint = type === 'changeset'
        ? `${API}/changeset/${encodeURIComponent(id)}/download`
        : `${API}/${type}/${encodeURIComponent(id)}/history`;
      const response = await fetchWithTimeout(endpoint, { headers: { Accept: 'application/xml' } }, 30000);
      if (lookupGeneration !== objectLookupGeneration) return;
      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          throw new Error(`${entityLabel(type, id)} was not found or is no longer available.`);
        }
        if (response.status === 429) throw new Error('The OpenStreetMap API is rate-limiting requests. Please wait a moment and retry.');
        throw new Error(`OpenStreetMap API returned ${response.status} for ${entityLabel(type, id)}.`);
      }
      const xml = await response.text();
      if (lookupGeneration !== objectLookupGeneration) return;
      await handleFile(new File([xml], `${type}-${id}-${type === 'changeset' ? 'download' : 'history'}.xml`, { type: 'application/xml' }), 'osm-api');
    } catch (error) {
      if (lookupGeneration === objectLookupGeneration) toast(error.message || `Could not load ${type} ${id}.`);
    } finally {
      if (lookupGeneration === objectLookupGeneration) {
        button.disabled = false;
        button.textContent = oldText;
      }
    }
  });
  $('objectSearchId').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('objectSearchBtn').click();
  });

  $('pointsBtn').addEventListener('click', togglePoints);
  $('showAllBtn').addEventListener('click', () => showAll(true));
  $('hideAllBtn').addEventListener('click', () => showAll(false));

  $('yearSearch').addEventListener('input', filterYears);

  // A file can also be dropped on the map without navigating away from the app.

  const mapArea = document.querySelector('.map-area');

  ['dragenter', 'dragover'].forEach(type => {
    mapArea.addEventListener(type, e => {
      e.preventDefault();
      mapArea.classList.add('drag-active');
    });
  });

  ['dragleave', 'drop'].forEach(type => {
    mapArea.addEventListener(type, e => {
      e.preventDefault();
      mapArea.classList.remove('drag-active');
    });
  });

  mapArea.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    const geojson = files.find(file => /\.(geojson|json)$/i.test(file.name));
    const osm = files.find(file => /\.(xml|osm)$/i.test(file.name));
    if (geojson) addGeoJSONFile(geojson);
    else if (osm) {
      objectLookupGeneration++;
      $('objectSearchBtn').disabled = false;
      $('objectSearchBtn').textContent = 'Load history';
      window.dispatchEvent(new CustomEvent('vaanam:source-file', { detail: { inputId: 'xmlFile', file: osm } }));
      handleFile(osm);
    } else toast('Drop an OSM XML or GeoJSON file here.');
  });

  window.addEventListener('resize', () => {
    if (state.map) {
      state.map.invalidateSize({ pan: false });
    }
  });

  window.addEventListener('beforeunload', () => {
    state.generation++;
  });

  initWorkspaceInteractions();
  initMap();
  const requestedPanel = window.location.hash.replace(/^#/, '').toLowerCase();
  const hasRequestedPanel = ['adddata', 'osm', 'change', 'lst', 'basemap'].includes(requestedPanel);
  const initialPanel = hasRequestedPanel ? (requestedPanel === 'adddata' ? 'addData' : requestedPanel) : 'addData';
  showPanel(initialPanel, hasRequestedPanel);
})();