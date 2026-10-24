/*
 * Europa + Marruecos 2026
 * Archivo: js/map.js
 *
 * Funciones:
 * - Mapa interactivo con Leaflet.
 * - Filtros por ciudad y texto.
 * - Lista del itinerario desplegable.
 * - Búsqueda libre de origen y destino con Photon.
 * - Búsqueda local en locations.json.
 * - Coordenadas manuales: latitud, longitud.
 * - Rutas en automóvil y a pie.
 * - Resumen compacto de distancia y duración.
 * - Ubicación GPS actual y seguimiento.
 * - Marcador de posición y círculo de precisión.
 * - Diagnóstico detallado de errores.
 *
 * Servicios:
 * - Photon: geocodificación.
 * - OpenStreetMap: mapa base.
 * - OSRM público de FOSSGIS: cálculo de rutas.
 * - Geolocation API: ubicación del dispositivo.
 */

(function () {
  "use strict";

  const CONFIG = {
    locationsUrl: "./data/locations.json",

    defaultCenter: [40.4168, -3.7038],
    defaultZoom: 5,

    photonUrl: "https://photon.komoot.io/api/",

    carRouteUrl:
      "https://routing.openstreetmap.de/routed-car/route/v1/driving",

    footRouteUrl:
      "https://routing.openstreetmap.de/routed-foot/route/v1/driving",

    routeColor: "#d34b35",

    searchDelay: 500,
    minimumSearchLength: 3,
    maximumSuggestions: 6,
    photonMinimumInterval: 1000,
    requestTimeout: 15000,

    routePlaceholder: "Hotel, dirección, estación, plaza...",

    // Configuración GPS
    gpsEnableHighAccuracy: true,
    gpsMaximumAge: 5000,
    gpsTimeout: 20000,
    gpsZoom: 16
  };

  let map = null;
  let markerLayer = null;
  let routeLayer = null;

  let allLocations = [];
  let markersById = new Map();

  let currentRoute = null;
  let routeRequestInProgress = false;
  let routeRequestSequence = 0;

  let selectedOrigin = null;
  let selectedDestination = null;

  // Estado de geolocalización
  let gpsWatchId = null;
  let gpsMarker = null;
  let gpsAccuracyCircle = null;
  let gpsControl = null;
  let gpsButton = null;
  let gpsStatus = null;
  let gpsTrackingActive = false;
  let gpsHasPosition = false;

  const searches = {
    origin: {
      timer: null,
      controller: null,
      sequence: 0,
      panel: null,
      lastPhotonRequestAt: 0
    },
    destination: {
      timer: null,
      controller: null,
      sequence: 0,
      panel: null,
      lastPhotonRequestAt: 0
    }
  };

  const state = {
    city: "all",
    search: "",
    locationListExpanded: false
  };

  // ------------------------------------------------------------
  // UTILIDADES
  // ------------------------------------------------------------

  function getElement(id) {
    return document.getElementById(id);
  }

  function hasCoordinates(location) {
    if (!location) return false;

    if (
      location.latitude === "" ||
      location.longitude === "" ||
      location.latitude === null ||
      location.longitude === null ||
      location.latitude === undefined ||
      location.longitude === undefined
    ) {
      return false;
    }

    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);

    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("es");
  }

  function getLocationDescription(location) {
    return [
      location.address,
      location.city,
      location.country
    ].filter(Boolean).join(" · ");
  }

  function getLocationLabel(location) {
    const name = location.name || "Ubicación sin nombre";

    const description = [
      location.city,
      location.country
    ].filter(Boolean).join(", ");

    return description ? `${name} — ${description}` : name;
  }

  function getOriginLabel(origin) {
    return origin?.label || getLocationLabel(origin || {});
  }

  function getDestinationLabel(destination) {
    return destination?.label || getLocationLabel(destination || {});
  }

  function showStatus(message) {
    const element = getElement("mapStatus");
    if (element) element.textContent = message;
  }

  function showRouteStatus(message) {
    const element = getElement("routeStatus");
    if (element) element.textContent = message;
  }

  function createPopup(location) {
    return `
      <div class="trip-map-popup">
        <strong>${escapeHtml(location.name || "Ubicación")}</strong>
        <div>${escapeHtml(getLocationDescription(location))}</div>
        <small>${escapeHtml(location.type || "Lugar del itinerario")}</small>
      </div>
    `;
  }

  function makePoint(location, defaultName) {
    return {
      id: location.id ?? null,
      name: location.name || defaultName,
      address: location.address || "",
      city: location.city || "",
      country: location.country || "",
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      label: location.label || getLocationLabel(location),
      source: location.source || "itinerary"
    };
  }

  function cancelSearch(type) {
    const search = searches[type];

    if (search.timer) {
      clearTimeout(search.timer);
      search.timer = null;
    }

    if (search.controller) {
      search.controller.abort();
      search.controller = null;
    }

    search.sequence += 1;
  }

  // ------------------------------------------------------------
  // ESTILOS COMPACTOS Y ADAPTABLES
  // ------------------------------------------------------------

  function installStyles() {
    if (getElement("tripMapEnhancedStyles")) return;

    const style = document.createElement("style");
    style.id = "tripMapEnhancedStyles";

    style.textContent = `
      /* Sugerencias de origen y destino */

      .trip-map-suggestions {
        box-sizing: border-box;
      }

      .trip-map-suggestion {
        display: block;
        width: 100%;
        padding: 9px 11px;
        text-align: left;
        color: #25332e;
        background: #fffdf8;
        border: 0;
        border-bottom: 1px solid #e7e7df;
        cursor: pointer;
        font-size: 0.9rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .trip-map-suggestion:hover,
      .trip-map-suggestion:focus {
        background: #edf2eb;
        outline: none;
      }

      /* Transporte y resumen en columnas */

      #routeTransportSummary {
        display: grid;
        grid-template-columns: minmax(145px, 0.75fr)
                               minmax(230px, 1.6fr);
        align-items: start;
        gap: 10px;
        width: 100%;
        margin: 8px 0;
      }

      #routeTransportSummary > * {
        min-width: 0;
        margin-top: 0;
        margin-bottom: 0;
      }

      #routeSummary {
        box-sizing: border-box;
        padding: 10px 12px;
        background: #f6f7f2;
        border: 1px solid #dfe3d9;
        border-radius: 9px;
        color: #26372f;
        font-size: 0.88rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      #routeSummary[hidden] {
        display: none !important;
      }

      #routeSummary .route-summary-title {
        margin: 0 0 5px;
        font-size: 0.96rem;
        font-weight: 700;
      }

      #routeSummary .route-summary-detail {
        margin: 3px 0;
      }

      #routeSummary .route-summary-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin: 6px 0;
      }

      #routeSummary .route-summary-metric {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-weight: 600;
      }

      #routeSummary .route-summary-warning {
        margin: 6px 0 0;
        color: #69746d;
        font-size: 0.76rem;
        line-height: 1.35;
      }

      /* Lista del itinerario */

      #mapLocationList[hidden] {
        display: none !important;
      }

      #mapLocationList {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      #mapLocationList .map-location-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
        padding: 10px 12px;
        text-align: left;
        color: #25332e;
        background: #fffdf8;
        border: 1px solid #dedfd5;
        border-radius: 9px;
        cursor: pointer;
        overflow-wrap: anywhere;
      }

      #mapLocationList .map-location-item:hover:not(:disabled) {
        background: #eef3ec;
        border-color: #8aa294;
      }

      #mapLocationList .map-location-item:disabled {
        color: #68756f;
        cursor: not-allowed;
        opacity: 0.8;
      }

      #mapLocationList .map-location-item span {
        font-size: 0.84rem;
        line-height: 1.35;
      }

      #mapLocationList .map-pending {
        color: #8a5b20;
      }

      /* Control GPS de Leaflet */

      .trip-map-gps-control {
        background: transparent;
        border: 0;
      }

      .trip-map-gps-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 42px;
        padding: 9px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 9px;
        background: #ffffff;
        color: #1e293b;
        box-shadow: 0 2px 8px #00000022;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }

      .trip-map-gps-button:hover {
        background: #f1f5f9;
      }

      .trip-map-gps-button:focus-visible {
        outline: 3px solid #60a5fa;
        outline-offset: 2px;
      }

      .trip-map-gps-button:disabled {
        cursor: wait;
        opacity: 0.75;
      }

      .trip-map-gps-button.is-active {
        color: #ffffff;
        background: #1769aa;
        border-color: #145a91;
      }

      .trip-map-gps-button.is-active:hover {
        background: #145a91;
      }

      .trip-map-gps-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 19px;
        height: 19px;
        flex: 0 0 19px;
        font-size: 19px;
        line-height: 1;
      }

      .trip-map-gps-status {
        max-width: 190px;
        margin-top: 5px;
        padding: 5px 7px;
        color: #334155;
        background: #ffffffed;
        border: 1px solid #dbe2ea;
        border-radius: 6px;
        box-shadow: 0 1px 5px #00000016;
        font-size: 11px;
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: anywhere;
      }

      .trip-map-gps-status:empty {
        display: none;
      }

      /* Marcador visual de ubicación actual */

      .trip-map-gps-marker {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 3px solid #ffffff;
        border-radius: 50%;
        background: #1685f8;
        box-shadow: 0 1px 7px #00000066;
        box-sizing: border-box;
      }

      .trip-map-gps-marker::after {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ffffff;
      }

      @media (max-width: 620px) {
        #routeTransportSummary {
          grid-template-columns: minmax(0, 1fr);
          gap: 7px;
        }

        #routeSummary {
          font-size: 0.86rem;
        }

        #mapLocationList {
          grid-template-columns: minmax(0, 1fr);
        }

        .trip-map-gps-button {
          min-height: 44px;
          padding: 9px 10px;
          font-size: 12px;
        }

        .trip-map-gps-status {
          max-width: 160px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // CAMPOS DE BÚSQUEDA
  // ------------------------------------------------------------

  function prepareOriginInput() {
    const input = getElement("routeOrigin");
    if (!input) return;

    input.type = "text";
    input.placeholder = CONFIG.routePlaceholder;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Punto de origen");
    input.setAttribute("aria-autocomplete", "list");
  }

  function prepareDestinationInput() {
    const existing = getElement("routeDestination");
    if (!existing) return;

    if (existing.tagName === "INPUT") {
      existing.type = "text";
      existing.placeholder = CONFIG.routePlaceholder;
      existing.autocomplete = "off";
      existing.setAttribute("aria-label", "Punto de destino");
      existing.setAttribute("aria-autocomplete", "list");
      return;
    }

    const input = document.createElement("input");

    input.type = "text";
    input.id = "routeDestination";
    input.name = existing.name || "routeDestination";
    input.placeholder = CONFIG.routePlaceholder;
    input.autocomplete = "off";
    input.className = existing.className || "";
    input.setAttribute("aria-label", "Punto de destino");
    input.setAttribute("aria-autocomplete", "list");

    if (existing.required) input.required = true;
    if (existing.disabled) input.disabled = true;

    existing.replaceWith(input);
  }

  // ------------------------------------------------------------
  // PRESENTACIÓN COMPACTA DEL TRANSPORTE Y LA RUTA
  // ------------------------------------------------------------

  function prepareCompactRouteLayout() {
    const modeSelect = getElement("routeMode");
    if (!modeSelect || !modeSelect.parentElement) return;

    let summary = getElement("routeSummary");

    if (!summary) {
      summary = document.createElement("div");
      summary.id = "routeSummary";
      summary.hidden = true;
    }

    let wrapper = getElement("routeTransportSummary");

    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = "routeTransportSummary";

      const modeField =
        modeSelect.closest(".field") ||
        modeSelect.parentElement;

      modeField.parentNode.insertBefore(wrapper, modeField);
      wrapper.appendChild(modeField);
      wrapper.appendChild(summary);
    } else {
      if (!wrapper.contains(modeSelect)) {
        const modeField =
          modeSelect.closest(".field") ||
          modeSelect.parentElement;

        wrapper.appendChild(modeField);
      }

      if (!wrapper.contains(summary)) {
        wrapper.appendChild(summary);
      }
    }

    summary.hidden = true;
  }

  // ------------------------------------------------------------
  // LISTA DEL ITINERARIO MOSTRAR / OCULTAR
  // ------------------------------------------------------------

  function prepareLocationListToggle() {
    const list = getElement("mapLocationList");
    if (!list) return;

    const button = getElement("toggleItineraryLocations");

    state.locationListExpanded = false;
    list.hidden = true;

    if (!button) {
      console.warn(
        "No se encontró el control #toggleItineraryLocations."
      );
      return;
    }

    button.setAttribute("aria-controls", "mapLocationList");
    button.setAttribute("aria-expanded", "false");

    if (button.dataset.toggleInitialized === "true") return;

    button.dataset.toggleInitialized = "true";

    button.addEventListener("click", function (event) {
      event.preventDefault();

      state.locationListExpanded = !state.locationListExpanded;
      list.hidden = !state.locationListExpanded;

      button.setAttribute(
        "aria-expanded",
        String(state.locationListExpanded)
      );
    });
  }

  function updateLocationListToggle() {
    const list = getElement("mapLocationList");
    if (!list) return;

    list.hidden = !state.locationListExpanded;

    const button = getElement("toggleItineraryLocations");

    if (button) {
      button.setAttribute(
        "aria-expanded",
        String(state.locationListExpanded)
      );
    }
  }

  // ------------------------------------------------------------
  // GPS: CONTROL DENTRO DEL MAPA LEAFLET
  // ------------------------------------------------------------

  function updateGpsControl(message) {
    if (gpsStatus) {
      gpsStatus.textContent = message || "";
    }

    if (gpsButton) {
      gpsButton.classList.toggle(
        "is-active",
        gpsTrackingActive
      );

      gpsButton.setAttribute(
        "aria-pressed",
        String(gpsTrackingActive)
      );

      gpsButton.innerHTML = gpsTrackingActive
        ? '<span class="trip-map-gps-icon" aria-hidden="true">◉</span><span>Detener GPS</span>'
        : '<span class="trip-map-gps-icon" aria-hidden="true">◎</span><span>Mi ubicación</span>';

      gpsButton.title = gpsTrackingActive
        ? "Detener el seguimiento de ubicación"
        : "Mostrar y seguir mi ubicación actual";
    }
  }

  function createGpsControl() {
    if (!map || typeof L === "undefined") return;
    if (gpsControl) return;

    gpsControl = L.control({ position: "topright" });

    gpsControl.onAdd = function () {
      const container = L.DomUtil.create(
        "div",
        "trip-map-gps-control"
      );

      const button = L.DomUtil.create(
        "button",
        "trip-map-gps-button",
        container
      );

      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Mostrar mi ubicación");
      button.innerHTML =
        '<span class="trip-map-gps-icon" aria-hidden="true">◎</span><span>Mi ubicación</span>';

      const status = L.DomUtil.create(
        "div",
        "trip-map-gps-status",
        container
      );

      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = "";

      gpsButton = button;
      gpsStatus = status;

      // Evitar que los clics del control muevan el mapa.
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(button, "click", function (event) {
        L.DomEvent.preventDefault(event);
        L.DomEvent.stopPropagation(event);

        if (gpsTrackingActive) {
          stopLocationTracking();
        } else {
          startLocationTracking();
        }
      });

      return container;
    };

    gpsControl.addTo(map);
  }

  function createGpsMarker() {
    if (!map || typeof L === "undefined") return;

    if (!gpsMarker) {
      const gpsIcon = L.divIcon({
        className: "",
        html: '<div class="trip-map-gps-marker"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      gpsMarker = L.marker([0, 0], {
        icon: gpsIcon,
        zIndexOffset: 10000,
        keyboard: true,
        title: "Mi ubicación actual"
      });

      gpsMarker.bindPopup(
        "<strong>Mi ubicación actual</strong>"
      );
    }

    if (!gpsAccuracyCircle) {
      gpsAccuracyCircle = L.circle([0, 0], {
        radius: 0,
        color: "#1685f8",
        weight: 1.5,
        opacity: 0.8,
        fillColor: "#1685f8",
        fillOpacity: 0.13,
        interactive: false
      });
    }
  }

  function startLocationTracking() {
    if (!map) {
      updateGpsControl("El mapa todavía no está disponible.");
      return;
    }

    if (!("geolocation" in navigator)) {
      updateGpsControl(
        "Este navegador no admite geolocalización."
      );
      return;
    }

    if (gpsTrackingActive) return;

    gpsTrackingActive = true;

    updateGpsControl(
      "Solicitando permiso y ubicación al dispositivo…"
    );

    if (gpsButton) {
      gpsButton.disabled = true;
    }

    createGpsMarker();

    try {
      gpsWatchId = navigator.geolocation.watchPosition(
        handleGpsPosition,
        handleGpsError,
        {
          enableHighAccuracy: CONFIG.gpsEnableHighAccuracy,
          maximumAge: CONFIG.gpsMaximumAge,
          timeout: CONFIG.gpsTimeout
        }
      );
    } catch (error) {
      gpsTrackingActive = false;
      gpsWatchId = null;

      if (gpsButton) {
        gpsButton.disabled = false;
      }

      updateGpsControl(
        "No fue posible iniciar el GPS. Inténtalo nuevamente."
      );

      console.error("No se pudo iniciar la geolocalización:", error);
    }
  }

  function handleGpsPosition(position) {
    if (!gpsTrackingActive || !map) return;

    const latitude = Number(position.coords.latitude);
    const longitude = Number(position.coords.longitude);
    const accuracy = Number(position.coords.accuracy);

    const point = {
      latitude,
      longitude
    };

    if (!hasCoordinates(point)) {
      updateGpsControl(
        "El dispositivo devolvió coordenadas no válidas."
      );
      return;
    }

    const latLng = L.latLng(latitude, longitude);

    createGpsMarker();

    gpsMarker.setLatLng(latLng);

    if (!map.hasLayer(gpsMarker)) {
      gpsMarker.addTo(map);
    }

    const validAccuracy =
      Number.isFinite(accuracy) && accuracy >= 0;

    if (validAccuracy) {
      gpsAccuracyCircle.setLatLng(latLng);
      gpsAccuracyCircle.setRadius(accuracy);

      if (!map.hasLayer(gpsAccuracyCircle)) {
        gpsAccuracyCircle.addTo(map);
      }
    }

    gpsHasPosition = true;

    const accuracyText = validAccuracy
      ? `Precisión estimada: ${Math.round(accuracy)} m.`
      : "Precisión estimada no disponible.";

    updateGpsControl(
      `Ubicación actualizada. ${accuracyText}`
    );

    if (gpsButton) {
      gpsButton.disabled = false;
    }

    // Centrar el mapa en la posición actual.
    // Se hace con cada actualización mientras el seguimiento está activo.
    map.setView(
      latLng,
      Math.max(map.getZoom(), CONFIG.gpsZoom),
      { animate: true }
    );

    // Actualizar el contenido del marcador.
    const timestamp = position.timestamp
      ? new Date(position.timestamp).toLocaleTimeString("es-MX")
      : "";

    gpsMarker.setPopupContent(`
      <div>
        <strong>Mi ubicación actual</strong>
        <div>Latitud: ${latitude.toFixed(6)}</div>
        <div>Longitud: ${longitude.toFixed(6)}</div>
        ${
          validAccuracy
            ? `<div>Precisión estimada: ${Math.round(accuracy)} m</div>`
            : ""
        }
        ${timestamp ? `<small>Actualización: ${escapeHtml(timestamp)}</small>` : ""}
      </div>
    `);
  }

  function handleGpsError(error) {
    if (!gpsTrackingActive) return;

    let message;

    switch (error.code) {
      case error.PERMISSION_DENIED:
        message =
          "Permiso denegado. Autoriza la ubicación en el navegador.";
        break;

      case error.POSITION_UNAVAILABLE:
        message =
          "El dispositivo no pudo determinar tu ubicación. Comprueba el GPS o la señal.";
        break;

      case error.TIMEOUT:
        message =
          "El GPS tardó demasiado en responder. Se seguirá intentando recibir la ubicación.";
        break;

      default:
        message =
          "No se pudo obtener la ubicación. Comprueba los permisos del navegador.";
        break;
    }

    updateGpsControl(message);

    if (gpsButton) {
      gpsButton.disabled = false;
    }

    console.warn("Aviso de geolocalización:", {
      code: error.code,
      message: error.message
    });

    // Si todavía no se obtuvo ninguna posición, dejamos el control
    // activo para permitir que el navegador vuelva a intentarlo.
    // El usuario puede detenerlo manualmente.
  }

  function stopLocationTracking() {
    gpsTrackingActive = false;

    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }

    // Retirar los elementos GPS del mapa.
    // Los marcadores y las rutas del itinerario no se modifican.
    if (map && gpsMarker && map.hasLayer(gpsMarker)) {
      map.removeLayer(gpsMarker);
    }

    if (
      map &&
      gpsAccuracyCircle &&
      map.hasLayer(gpsAccuracyCircle)
    ) {
      map.removeLayer(gpsAccuracyCircle);
    }

    gpsHasPosition = false;

    if (gpsButton) {
      gpsButton.disabled = false;
    }

    updateGpsControl("Seguimiento detenido.");
  }

  // ------------------------------------------------------------
  // MAPA LEAFLET
  // ------------------------------------------------------------

  function initializeMap() {
    const mapElement = getElement("tripMap");

    if (!mapElement) {
      showStatus("No se encontró el contenedor del mapa.");
      return false;
    }

    if (typeof L === "undefined") {
      showStatus(
        "No se pudo cargar Leaflet. Comprueba tu conexión a internet."
      );

      console.error("Leaflet no está disponible.");
      return false;
    }

    map = L.map(mapElement).setView(
      CONFIG.defaultCenter,
      CONFIG.defaultZoom
    );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
      }
    ).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    // Agregar el control GPS en la esquina superior derecha.
    createGpsControl();

    return true;
  }

  // ------------------------------------------------------------
  // FILTROS Y MARCADORES
  // ------------------------------------------------------------

  function renderCityOptions() {
    const select = getElement("mapCityFilter");
    if (!select) return;

    const cities = [
      ...new Set(
        allLocations
          .map(location => location.city)
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b, "es"));

    select.innerHTML = [
      '<option value="all">Todas las ciudades</option>',
      ...cities.map(city =>
        `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`
      )
    ].join("");

    select.value = state.city;
  }

  function matchesFilters(location) {
    const cityMatches =
      state.city === "all" || location.city === state.city;

    const query = normalizeText(state.search);

    const searchMatches =
      !query ||
      [
        location.name,
        location.city,
        location.country,
        location.address,
        location.type
      ]
        .filter(Boolean)
        .some(value => normalizeText(value).includes(query));

    return cityMatches && searchMatches;
  }

  function renderMarkers() {
    if (!map || !markerLayer) return;

    markerLayer.clearLayers();
    markersById.clear();

    const visible = allLocations.filter(
      location => matchesFilters(location) && hasCoordinates(location)
    );

    const bounds = [];

    visible.forEach(location => {
      const marker = L.marker([
        Number(location.latitude),
        Number(location.longitude)
      ]);

      marker.bindPopup(createPopup(location));
      marker.addTo(markerLayer);

      if (location.id !== undefined && location.id !== null) {
        markersById.set(String(location.id), marker);
      }

      bounds.push([
        Number(location.latitude),
        Number(location.longitude)
      ]);
    });

    if (bounds.length) {
      map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: 13
      });
    } else {
      map.setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
    }

    const pending = allLocations.filter(
      location => matchesFilters(location) && !hasCoordinates(location)
    ).length;

    showStatus(
      `${visible.length} ubicaciones en el mapa` +
      (pending ? ` · ${pending} pendientes de coordenadas` : "")
    );

    renderLocationList();
  }

  function renderLocationList() {
    const list = getElement("mapLocationList");
    if (!list) return;

    const locations = allLocations
      .filter(matchesFilters)
      .sort((a, b) => {
        const cityCompare = String(a.city || "").localeCompare(
          String(b.city || ""),
          "es"
        );

        return cityCompare ||
          String(a.name || "").localeCompare(
            String(b.name || ""),
            "es"
          );
      });

    if (!locations.length) {
      list.innerHTML =
        "<p>No hay ubicaciones que coincidan con el filtro.</p>";

      updateLocationListToggle();
      return;
    }

    list.innerHTML = locations.map(location => {
      const available = hasCoordinates(location);

      return `
        <button
          type="button"
          class="map-location-item"
          data-location-id="${escapeHtml(location.id ?? "")}"
          ${available ? "" : "disabled"}
        >
          <strong>${escapeHtml(location.name || "Ubicación sin nombre")}</strong>
          <span>${escapeHtml(getLocationDescription(location) || "Sin dirección adicional")}</span>
          ${
            available
              ? ""
              : '<span class="map-pending">Ubicación por confirmar</span>'
          }
        </button>
      `;
    }).join("");

    list.querySelectorAll("[data-location-id]").forEach(button => {
      button.addEventListener("click", function () {
        showLocation(button.dataset.locationId);
      });
    });

    updateLocationListToggle();
  }

  function connectFilters() {
    const citySelect = getElement("mapCityFilter");
    const searchInput = getElement("mapSearch");

    if (citySelect) {
      citySelect.addEventListener("change", function () {
        state.city = citySelect.value;
        renderMarkers();
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.search = searchInput.value;
        renderMarkers();
      });
    }
  }

  function showLocation(id) {
    if (id === undefined || id === null || id === "") {
      return false;
    }

    const key = String(id);
    let marker = markersById.get(key);

    if (!marker) {
      const location = allLocations.find(
        item => String(item.id) === key
      );

      if (!location || !hasCoordinates(location)) return false;

      state.city = "all";
      state.search = "";

      const citySelect = getElement("mapCityFilter");
      const searchInput = getElement("mapSearch");

      if (citySelect) citySelect.value = "all";
      if (searchInput) searchInput.value = "";

      renderMarkers();
      marker = markersById.get(key);
    }

    if (!marker || !map) return false;

    map.setView(marker.getLatLng(), 15);
    marker.openPopup();

    return true;
  }

  // ------------------------------------------------------------
  // PANELES DE SUGERENCIAS
  // ------------------------------------------------------------

  function ensureSuggestionPanel(type) {
    const input = getElement(
      type === "origin" ? "routeOrigin" : "routeDestination"
    );

    if (!input || searches[type].panel) return;

    const panel = document.createElement("div");

    panel.id = type === "origin"
      ? "routeOriginSuggestionsPanel"
      : "routeDestinationSuggestionsPanel";

    panel.className = "trip-map-suggestions";
    panel.setAttribute("role", "listbox");

    Object.assign(panel.style, {
      display: "none",
      position: "absolute",
      top: "calc(100% + 4px)",
      left: "0",
      right: "0",
      zIndex: "3000",
      maxHeight: "280px",
      overflowY: "auto",
      background: "#fffdf8",
      border: "1px solid #c9d0ca",
      borderRadius: "8px",
      boxShadow: "0 5px 16px #00000018"
    });

    const field = input.closest(".field");

    if (field) {
      const position = getComputedStyle(field).position;

      if (position === "static") {
        field.style.position = "relative";
      }

      field.appendChild(panel);
    } else {
      const parent = input.parentElement;

      if (parent && getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }

      input.insertAdjacentElement("afterend", panel);
    }

    searches[type].panel = panel;
  }

  function hideSuggestions(type) {
    const panel = searches[type].panel;

    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
    }
  }

  function showSuggestionMessage(type, message) {
    const panel = searches[type].panel;
    if (!panel) return;

    panel.innerHTML = "";

    const item = document.createElement("div");

    Object.assign(item.style, {
      padding: "10px 12px",
      color: "#68766f",
      fontSize: "0.88rem",
      lineHeight: "1.4"
    });

    item.textContent = message;
    panel.appendChild(item);
    panel.style.display = "block";
  }

  function renderSuggestions(type, items, messageIfEmpty) {
    const panel = searches[type].panel;
    if (!panel) return;

    panel.innerHTML = "";

    if (!items.length) {
      showSuggestionMessage(
        type,
        messageIfEmpty || "No se encontraron lugares."
      );
      return;
    }

    items.forEach(item => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "trip-map-suggestion";
      button.textContent = item.label;
      button.setAttribute("role", "option");

      button.addEventListener("click", function () {
        chooseSearchResult(type, item);
      });

      panel.appendChild(button);
    });

    panel.style.display = "block";
  }

  function chooseSearchResult(type, item) {
    const input = getElement(
      type === "origin" ? "routeOrigin" : "routeDestination"
    );

    if (!input || !hasCoordinates(item)) return;

    const chosen = {
      ...item,
      latitude: Number(item.latitude),
      longitude: Number(item.longitude)
    };

    if (type === "origin") {
      selectedOrigin = chosen;
    } else {
      selectedDestination = chosen;
    }

    input.value = chosen.label || getLocationLabel(chosen);

    hideSuggestions(type);

    if (currentRoute) {
      clearRoute({ showStatus: false });
    }

    showRouteStatus(
      `${type === "origin" ? "Origen" : "Destino"} seleccionado. Pulsa «Calcular ruta» para continuar.`
    );
  }

  // ------------------------------------------------------------
  // BÚSQUEDA LOCAL
  // ------------------------------------------------------------

  function getLocalSuggestions(query) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    return allLocations
      .filter(location => {
        if (!hasCoordinates(location)) return false;

        return [
          location.name,
          location.address,
          location.city,
          location.country,
          location.type
        ].some(value =>
          normalizeText(value).includes(normalizedQuery)
        );
      })
      .slice(0, CONFIG.maximumSuggestions)
      .map(location => ({
        id: location.id,
        name: location.name,
        address: location.address || "",
        city: location.city || "",
        country: location.country || "",
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        label: getLocationLabel(location),
        source: "itinerary"
      }));
  }

  // ------------------------------------------------------------
  // GEOCODIFICACIÓN PHOTON
  // ------------------------------------------------------------

  function getPhotonCoordinates(feature) {
    const coordinates =
      feature?.geometry?.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    // GeoJSON: [longitud, latitud].
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);

    const result = { latitude, longitude };

    return hasCoordinates(result) ? result : null;
  }

  function mapPhotonFeature(feature) {
    const coordinates = getPhotonCoordinates(feature);
    if (!coordinates) return null;

    const properties = feature.properties || {};

    const name = properties.name || properties.street;

    if (!name) return null;

    const city =
      properties.city ||
      properties.district ||
      properties.locality ||
      properties.county ||
      "";

    const country = properties.country || "";

    const label = [name, [city, country].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" — ");

    return {
      name,
      city,
      country,
      address: [
        properties.street,
        properties.housenumber
      ].filter(Boolean).join(" "),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      label,
      source: "photon"
    };
  }

  async function searchPhoton(query, type, sequence) {
    const search = searches[type];

    if (search.controller) {
      search.controller.abort();
    }

    const controller = new AbortController();
    search.controller = controller;

    const url = new URL(CONFIG.photonUrl);

    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(CONFIG.maximumSuggestions));
    url.searchParams.set("lang", "en");

    const elapsed = Date.now() - search.lastPhotonRequestAt;

    if (elapsed < CONFIG.photonMinimumInterval) {
      await new Promise(resolve =>
        setTimeout(resolve, CONFIG.photonMinimumInterval - elapsed)
      );
    }

    if (sequence !== search.sequence) return [];

    let timeoutId;

    try {
      timeoutId = setTimeout(
        () => controller.abort(),
        CONFIG.requestTimeout
      );

      search.lastPhotonRequestAt = Date.now();

      let response;

      try {
        response = await fetch(url.toString(), {
          method: "GET",
          signal: controller.signal,
          headers: {
            Accept: "application/json"
          }
        });
      } catch (error) {
        if (error.name === "AbortError") {
          if (sequence !== search.sequence) return [];

          throw new Error(
            "La consulta tardó demasiado o fue cancelada. Inténtalo nuevamente."
          );
        }

        throw new Error(
          "No se pudo conectar con Photon. Comprueba tu conexión o si el servicio está disponible."
        );
      }

      if (!response.ok) {
        throw new Error(
          `Photon respondió con error HTTP ${response.status}.`
        );
      }

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          "El buscador respondió, pero no devolvió datos JSON válidos."
        );
      }

      if (sequence !== search.sequence) return [];

      if (!data || !Array.isArray(data.features)) {
        throw new Error(
          "El buscador devolvió una respuesta con formato inesperado."
        );
      }

      return data.features
        .map(mapPhotonFeature)
        .filter(Boolean);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // ------------------------------------------------------------
  // BÚSQUEDA EN ORIGEN Y DESTINO
  // ------------------------------------------------------------

  async function performSearch(type, query, sequence) {
    const localResults = getLocalSuggestions(query);

    if (localResults.length) {
      renderSuggestions(type, localResults, "");
    } else {
      showSuggestionMessage(type, "Buscando lugares…");
    }

    try {
      const remoteResults = await searchPhoton(
        query,
        type,
        sequence
      );

      if (sequence !== searches[type].sequence) return;

      const combined = [...localResults];

      const seen = new Set(
        combined.map(item =>
          `${normalizeText(item.name)}|${Number(item.latitude).toFixed(5)}|${Number(item.longitude).toFixed(5)}`
        )
      );

      remoteResults.forEach(item => {
        const key =
          `${normalizeText(item.name)}|${Number(item.latitude).toFixed(5)}|${Number(item.longitude).toFixed(5)}`;

        if (!seen.has(key)) {
          seen.add(key);
          combined.push(item);
        }
      });

      renderSuggestions(
        type,
        combined.slice(0, CONFIG.maximumSuggestions),
        "No se encontraron coincidencias. Prueba con el nombre y la ciudad."
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      if (sequence !== searches[type].sequence) return;

      console.error("Error en la búsqueda geográfica:", {
        campo: type,
        consulta: query,
        mensaje: error.message,
        servicio: CONFIG.photonUrl
      });

      if (localResults.length) {
        renderSuggestions(
          type,
          localResults,
          "El buscador externo no respondió."
        );
      } else {
        showSuggestionMessage(
          type,
          error.message ||
          "No se pudo consultar el buscador. Comprueba tu conexión."
        );
      }
    }
  }

  function connectSearch(type) {
    const input = getElement(
      type === "origin" ? "routeOrigin" : "routeDestination"
    );

    if (!input) return;

    ensureSuggestionPanel(type);

    input.placeholder = CONFIG.routePlaceholder;
    input.autocomplete = "off";

    input.addEventListener("input", function () {
      if (type === "origin") {
        selectedOrigin = null;
      } else {
        selectedDestination = null;
      }

      if (currentRoute) {
        clearRoute({ showStatus: false });
      }

      const search = searches[type];

      if (search.timer) clearTimeout(search.timer);

      if (search.controller) {
        search.controller.abort();
        search.controller = null;
      }

      search.sequence += 1;

      const sequence = search.sequence;
      const query = input.value.trim();

      if (query.length < CONFIG.minimumSearchLength) {
        const localResults = query
          ? getLocalSuggestions(query)
          : [];

        if (localResults.length) {
          renderSuggestions(type, localResults, "");
        } else {
          hideSuggestions(type);
        }

        return;
      }

      search.timer = setTimeout(function () {
        performSearch(type, query, sequence);
      }, CONFIG.searchDelay);
    });

    input.addEventListener("focus", function () {
      const query = input.value.trim();

      if (query.length >= CONFIG.minimumSearchLength) {
        input.dispatchEvent(new Event("input"));
      }
    });

    input.addEventListener("keydown", function (event) {
      const panel = searches[type].panel;

      if (event.key === "Escape") {
        hideSuggestions(type);
      }

      if (event.key === "Enter") {
        const firstButton = panel?.querySelector("button");

        if (firstButton && panel.style.display !== "none") {
          event.preventDefault();
          firstButton.click();
        }
      }
    });

    document.addEventListener("click", function (event) {
      const panel = searches[type].panel;

      if (
        panel &&
        !panel.contains(event.target) &&
        event.target !== input
      ) {
        hideSuggestions(type);
      }
    });
  }

  // ------------------------------------------------------------
  // RESOLVER ORIGEN Y DESTINO
  // ------------------------------------------------------------

  function parseCoordinates(text) {
    const parts = String(text)
      .trim()
      .split(/[;,]/)
      .map(part => part.trim());

    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1]
    ) {
      return null;
    }

    const latitude = Number(parts[0]);
    const longitude = Number(parts[1]);

    const result = { latitude, longitude };

    return hasCoordinates(result) ? result : null;
  }

  function findExactLocalLocation(text) {
    const query = normalizeText(text);
    if (!query) return null;

    return allLocations.find(location => {
      if (!hasCoordinates(location)) return false;

      return [
        getLocationLabel(location),
        location.name,
        location.address
      ].some(value => normalizeText(value) === query);
    }) || null;
  }

  async function resolvePoint(type) {
    const isOrigin = type === "origin";

    const input = getElement(
      isOrigin ? "routeOrigin" : "routeDestination"
    );

    const text = input?.value.trim() || "";

    const selected = isOrigin
      ? selectedOrigin
      : selectedDestination;

    if (!text) {
      throw new Error(
        `Escribe un lugar o coordenadas para el ${isOrigin ? "origen" : "destino"}.`
      );
    }

    if (
      selected &&
      normalizeText(selected.label) === normalizeText(text) &&
      hasCoordinates(selected)
    ) {
      return selected;
    }

    const coordinates = parseCoordinates(text);

    if (coordinates) {
      const result = {
        name: isOrigin ? "Origen por coordenadas" : "Destino por coordenadas",
        label: `Coordenadas: ${coordinates.latitude}, ${coordinates.longitude}`,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        source: "coordinates"
      };

      if (isOrigin) selectedOrigin = result;
      else selectedDestination = result;

      return result;
    }

    const local = findExactLocalLocation(text);

    if (local) {
      const result = makePoint(
        local,
        isOrigin ? "Origen" : "Destino"
      );

      if (isOrigin) selectedOrigin = result;
      else selectedDestination = result;

      return result;
    }

    showRouteStatus(
      `Buscando las coordenadas del ${isOrigin ? "origen" : "destino"}…`
    );

    cancelSearch(type);
    const sequence = searches[type].sequence;

    let results;

    try {
      results = await searchPhoton(text, type, sequence);
    } catch (error) {
      console.error("Error al resolver el punto:", {
        tipo: type,
        consulta: text,
        mensaje: error.message
      });

      throw new Error(
        `No se pudo localizar el ${isOrigin ? "origen" : "destino"}. ${error.message}`
      );
    }

    if (sequence !== searches[type].sequence) {
      throw new Error(
        "La búsqueda cambió mientras se procesaba. Selecciona nuevamente el lugar."
      );
    }

    if (!results.length) {
      throw new Error(
        `No se encontró el ${isOrigin ? "origen" : "destino"} «${text}». Prueba con el nombre y la ciudad, o selecciona una sugerencia.`
      );
    }

    if (results.length > 1) {
      renderSuggestions(type, results, "");

      throw new Error(
        `Hay varias coincidencias para «${text}». Selecciona el lugar correcto en las sugerencias.`
      );
    }

    const result = results[0];

    if (isOrigin) selectedOrigin = result;
    else selectedDestination = result;

    if (input) input.value = result.label;

    hideSuggestions(type);

    return result;
  }

  // ------------------------------------------------------------
  // CONTROLES DEL FORMULARIO
  // ------------------------------------------------------------

  function populateRouteSelectors() {
    const originInput = getElement("routeOrigin");
    const destinationInput = getElement("routeDestination");
    const calculateButton = getElement("calculateRoute");

    if (originInput) {
      originInput.disabled = false;
      originInput.placeholder = CONFIG.routePlaceholder;
    }

    if (destinationInput) {
      destinationInput.disabled = false;
      destinationInput.placeholder = CONFIG.routePlaceholder;
    }

    if (calculateButton) {
      calculateButton.disabled = false;
    }

    const datalist = getElement("routeOriginSuggestions");

    if (datalist) {
      datalist.innerHTML = allLocations
        .filter(hasCoordinates)
        .map(location => `
          <option value="${escapeHtml(getLocationLabel(location))}"></option>
        `)
        .join("");
    }

    const count = allLocations.filter(hasCoordinates).length;

    showRouteStatus(
      count
        ? `${count} lugares del itinerario disponibles. También puedes buscar direcciones y lugares externos.`
        : "Puedes buscar lugares externos o introducir coordenadas manualmente."
    );
  }

  // ------------------------------------------------------------
  // FORMATO Y RESUMEN DE RUTA
  // ------------------------------------------------------------

  function formatDistance(meters) {
    const kilometers = meters / 1000;

    return kilometers < 1
      ? `${Math.round(meters)} m`
      : `${kilometers.toLocaleString("es-MX", {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1
        })} km`;
  }

  function formatDuration(seconds) {
    const totalMinutes = Math.round(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) return `${totalMinutes} min`;
    if (minutes === 0) return `${hours} h`;

    return `${hours} h ${minutes} min`;
  }

  function renderRouteSummary(origin, destination, route, mode) {
    const summary = getElement("routeSummary");
    if (!summary) return;

    const modeLabel = mode === "walking" ? "A pie" : "Automóvil";

    summary.innerHTML = `
      <p class="route-summary-title">Resumen de la ruta</p>

      <div class="route-summary-metrics">
        <span class="route-summary-metric">
          <span aria-hidden="true">↔</span>
          ${escapeHtml(formatDistance(route.distance))}
        </span>

        <span class="route-summary-metric">
          <span aria-hidden="true">◷</span>
          ${escapeHtml(formatDuration(route.duration))}
        </span>

        <span class="route-summary-metric">
          <span aria-hidden="true">●</span>
          ${escapeHtml(modeLabel)}
        </span>
      </div>

      <p class="route-summary-detail">
        <strong>Origen:</strong>
        ${escapeHtml(getOriginLabel(origin))}
      </p>

      <p class="route-summary-detail">
        <strong>Destino:</strong>
        ${escapeHtml(getDestinationLabel(destination))}
      </p>

      <p class="route-summary-warning">
        Duración estimada según el servicio de rutas; no incluye tráfico en tiempo real.
      </p>
    `;

    summary.hidden = false;
  }

  function clearRoute(options = {}) {
    if (routeLayer) routeLayer.clearLayers();

    currentRoute = null;

    const summary = getElement("routeSummary");

    if (summary) {
      summary.innerHTML = "";
      summary.hidden = true;
    }

    if (options.showStatus !== false) {
      showRouteStatus(
        "Ruta eliminada. Puedes seleccionar otros puntos y calcular una nueva."
      );
    }
  }

  // ------------------------------------------------------------
  // CÁLCULO DE RUTA
  // ------------------------------------------------------------

  async function calculateRoute() {
    if (routeRequestInProgress) return;

    const requestId = ++routeRequestSequence;

    const originInput = getElement("routeOrigin");
    const destinationInput = getElement("routeDestination");
    const modeSelect = getElement("routeMode");
    const calculateButton = getElement("calculateRoute");

    if (!originInput || !destinationInput) {
      showRouteStatus(
        "No se encontraron los campos de origen y destino en map.html."
      );
      return;
    }

    if (!originInput.value.trim()) {
      showRouteStatus("Escribe o selecciona un punto de origen.");
      originInput.focus();
      return;
    }

    if (!destinationInput.value.trim()) {
      showRouteStatus("Escribe o selecciona un punto de destino.");
      destinationInput.focus();
      return;
    }

    const mode =
      modeSelect && modeSelect.value === "walking"
        ? "walking"
        : "driving";

    routeRequestInProgress = true;

    if (calculateButton) calculateButton.disabled = true;

    clearRoute({ showStatus: false });

    try {
      const origin = await resolvePoint("origin");
      const destination = await resolvePoint("destination");

      if (requestId !== routeRequestSequence) return;

      if (!hasCoordinates(origin)) {
        throw new Error("El origen no contiene coordenadas válidas.");
      }

      if (!hasCoordinates(destination)) {
        throw new Error("El destino no contiene coordenadas válidas.");
      }

      if (
        Math.abs(origin.latitude - destination.latitude) < 0.000001 &&
        Math.abs(origin.longitude - destination.longitude) < 0.000001
      ) {
        throw new Error(
          "El origen y el destino son el mismo punto. Selecciona otro lugar."
        );
      }

      showRouteStatus(
        mode === "walking"
          ? "Calculando ruta a pie…"
          : "Calculando ruta en automóvil…"
      );

      const routeBase = mode === "walking"
        ? CONFIG.footRouteUrl
        : CONFIG.carRouteUrl;

      // OSRM utiliza longitud,latitud.
      const coordinates = [
        `${origin.longitude},${origin.latitude}`,
        `${destination.longitude},${destination.latitude}`
      ].join(";");

      const url =
        `${routeBase}/${coordinates}` +
        "?overview=full&geometries=geojson&steps=false";

      let response;

      try {
        response = await fetch(url, {
          headers: { Accept: "application/json" }
        });
      } catch (error) {
        throw new Error(
          "No se pudo conectar con el servicio de rutas. Comprueba tu conexión e inténtalo de nuevo."
        );
      }

      if (!response.ok) {
        throw new Error(
          `El servicio de rutas respondió con error HTTP ${response.status}.`
        );
      }

      const data = await response.json();

      if (
        data.code !== "Ok" ||
        !Array.isArray(data.routes) ||
        !data.routes.length ||
        !data.routes[0].geometry
      ) {
        throw new Error(
          "No se encontró una ruta entre esos puntos. Comprueba las ubicaciones o prueba con puntos más cercanos."
        );
      }

      if (requestId !== routeRequestSequence) return;

      const route = data.routes[0];

      const routeLine = L.geoJSON({
        type: "Feature",
        properties: {},
        geometry: route.geometry
      }, {
        style: {
          color: CONFIG.routeColor,
          weight: 5,
          opacity: 0.9
        }
      });

      routeLine.addTo(routeLayer);

      L.circleMarker(
        [origin.latitude, origin.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#238443",
          fillOpacity: 1
        }
      )
        .bindPopup(
          `<strong>Origen:</strong> ${escapeHtml(getOriginLabel(origin))}`
        )
        .addTo(routeLayer);

      L.circleMarker(
        [destination.latitude, destination.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2459a6",
          fillOpacity: 1
        }
      )
        .bindPopup(
          `<strong>Destino:</strong> ${escapeHtml(getDestinationLabel(destination))}`
        )
        .addTo(routeLayer);

      const bounds = routeLine.getBounds();

      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          padding: [35, 35],
          maxZoom: 16
        });
      }

      currentRoute = {
        origin: makePoint(origin, "Origen"),
        destination: makePoint(destination, "Destino"),
        mode,
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry
      };

      renderRouteSummary(origin, destination, route, mode);

      showRouteStatus("Ruta calculada correctamente.");
    } catch (error) {
      console.error("Error al calcular la ruta:", error);

      if (requestId === routeRequestSequence) {
        showRouteStatus(
          error.message ||
          "No se pudo calcular la ruta. Comprueba tu conexión e inténtalo de nuevo."
        );
      }
    } finally {
      if (requestId === routeRequestSequence) {
        routeRequestInProgress = false;

        if (calculateButton) {
          calculateButton.disabled = false;
        }
      }
    }
  }

  function connectRouteControls() {
    const calculateButton = getElement("calculateRoute");
    const clearButton = getElement("clearRoute");

    if (calculateButton) {
      calculateButton.addEventListener("click", calculateRoute);
    }

    if (clearButton) {
      clearButton.addEventListener("click", function () {
        ++routeRequestSequence;
        routeRequestInProgress = false;

        if (calculateButton) {
          calculateButton.disabled = false;
        }

        clearRoute();
      });
    }

    connectSearch("origin");
    connectSearch("destination");
  }

  // ------------------------------------------------------------
  // CARGA DE LOCATIONS.JSON
  // ------------------------------------------------------------

  async function loadLocations() {
    showStatus("Cargando ubicaciones…");

    try {
      const response = await fetch(CONFIG.locationsUrl, {
        cache: "no-cache"
      });

      if (!response.ok) {
        throw new Error(
          `No se pudo leer locations.json (HTTP ${response.status}).`
        );
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.locations)) {
        throw new Error(
          "locations.json no contiene un arreglo locations válido."
        );
      }

      allLocations = data.locations.filter(location =>
        location &&
        typeof location === "object" &&
        typeof location.name === "string"
      );

      const params = new URLSearchParams(window.location.search);
      const requestedCity = params.get("city");
      const requestedLocation = params.get("location");

      if (requestedCity) {
        const matchingCity = allLocations.find(location =>
          normalizeText(location.city) === normalizeText(requestedCity)
        );

        state.city = matchingCity ? matchingCity.city : "all";
      } else {
        state.city = "all";
      }

      renderCityOptions();
      renderMarkers();
      populateRouteSelectors();

      if (requestedLocation && !showLocation(requestedLocation)) {
        showStatus(
          "No se encontró el marcador solicitado. Revisa el ID y las coordenadas en locations.json."
        );
      }

      if (!allLocations.length) {
        showStatus("No se encontraron ubicaciones en el archivo.");
      } else if (!allLocations.some(hasCoordinates)) {
        showStatus(
          "Las ubicaciones se cargaron, pero ninguna tiene coordenadas válidas."
        );
      }
    } catch (error) {
      console.error("Error al cargar locations.json:", error);

      showStatus(
        "No se pudieron cargar las ubicaciones. Verifica la ruta y el formato de locations.json."
      );

      showRouteStatus(
        "No se pudieron cargar las ubicaciones del itinerario. Puedes intentar buscar un lugar externo."
      );
    }
  }

  // ------------------------------------------------------------
  // INICIO Y API PÚBLICA
  // ------------------------------------------------------------

  function start() {
    installStyles();

    prepareOriginInput();
    prepareDestinationInput();

    prepareCompactRouteLayout();
    prepareLocationListToggle();

    if (!initializeMap()) return;

    connectFilters();
    connectRouteControls();

    loadLocations();
  }

  window.TripMap = {
    start,
    refresh: loadLocations,
    showLocation,
    calculateRoute,
    clearRoute,

    // Funciones GPS disponibles para pruebas desde la consola.
    startLocationTracking,
    stopLocationTracking,

    filterByCity: function (city) {
      state.city = city || "all";

      const select = getElement("mapCityFilter");

      if (select) {
        select.value = state.city;
      }

      renderMarkers();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
