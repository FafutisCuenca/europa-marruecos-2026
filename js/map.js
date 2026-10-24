
/*
 * Europa + Marruecos 2026
 * Archivo: js/map.js
 *
 * Funciones:
 * - Mapa interactivo con Leaflet.
 * - Filtros por ciudad y texto.
 * - Apertura de ubicaciones desde el itinerario.
 * - Origen libre con sugerencias geográficas.
 * - Búsqueda de lugares con Photon / OpenStreetMap.
 * - Entrada manual de coordenadas: latitud, longitud.
 * - Rutas para automóvil y a pie.
 * - Distancia, duración estimada y limpieza de rutas.
 *
 * Servicios públicos:
 * - Photon: búsqueda geográfica.
 * - OpenStreetMap: mapa base.
 * - OSRM público de FOSSGIS: cálculo de rutas.
 *
 * Se requiere conexión a internet.
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
    maximumSuggestions: 6
  };

  let map = null;
  let markerLayer = null;
  let routeLayer = null;

  let allLocations = [];
  let markersById = new Map();

  let currentRoute = null;
  let routeRequestInProgress = false;

  let selectedOrigin = null;
  let searchTimer = null;
  let searchController = null;
  let searchSequence = 0;
  let lastPhotonRequestAt = 0;

  let suggestionPanel = null;

  const state = {
    city: "all",
    search: ""
  };

  // ------------------------------------------------------------
  // UTILIDADES
  // ------------------------------------------------------------

  function getElement(id) {
    return document.getElementById(id);
  }

  function hasCoordinates(location) {
    return Boolean(
      location &&
      typeof location.latitude === "number" &&
      Number.isFinite(location.latitude) &&
      typeof location.longitude === "number" &&
      Number.isFinite(location.longitude) &&
      location.latitude >= -90 &&
      location.latitude <= 90 &&
      location.longitude >= -180 &&
      location.longitude <= 180
    );
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (char) {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };

      return entities[char];
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
    return origin.label ||
      getLocationLabel(origin) ||
      "Origen seleccionado";
  }

  function showStatus(message) {
    const element = getElement("mapStatus");

    if (element) {
      element.textContent = message;
    }
  }

  function showRouteStatus(message) {
    const element = getElement("routeStatus");

    if (element) {
      element.textContent = message;
    }
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

  function createExternalLabel(feature) {
    const properties = feature.properties || {};

    const name = properties.name || "Lugar sin nombre";

    const city =
      properties.city ||
      properties.district ||
      properties.locality ||
      properties.county ||
      "";

    const country = properties.country || "";

    const description = [city, country]
      .filter(Boolean)
      .join(", ");

    return {
      name,
      city,
      country,
      label: description ? `${name} — ${description}` : name
    };
  }

  function makeOrigin(location) {
    return {
      id: location.id ?? null,
      name: location.name || "Origen",
      address: location.address || "",
      city: location.city || "",
      country: location.country || "",
      latitude: location.latitude,
      longitude: location.longitude,
      label: location.label || getLocationLabel(location)
    };
  }

  // ------------------------------------------------------------
  // INICIALIZAR MAPA
  // ------------------------------------------------------------

  function initializeMap() {
    const mapElement = getElement("tripMap");

    if (!mapElement) {
      showStatus("No se encontró el contenedor del mapa.");
      return false;
    }

    if (typeof L === "undefined") {
      showStatus(
        "No se pudo cargar Leaflet. Revisa la conexión a internet."
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

    return true;
  }

  // ------------------------------------------------------------
  // FILTROS DEL MAPA
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

    const visibleLocations = allLocations.filter(
      location => matchesFilters(location) && hasCoordinates(location)
    );

    const bounds = [];

    visibleLocations.forEach(location => {
      const marker = L.marker([
        location.latitude,
        location.longitude
      ]);

      marker.bindPopup(createPopup(location));
      marker.addTo(markerLayer);

      if (location.id !== undefined && location.id !== null) {
        markersById.set(String(location.id), marker);
      }

      bounds.push([
        location.latitude,
        location.longitude
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

    const pendingCount = allLocations.filter(
      location => matchesFilters(location) && !hasCoordinates(location)
    ).length;

    showStatus(
      `${visibleLocations.length} ubicaciones en el mapa` +
      (pendingCount
        ? ` · ${pendingCount} pendientes de coordenadas`
        : "")
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
      return;
    }

    list.innerHTML = locations.map(location => {
      const name = escapeHtml(location.name || "Ubicación sin nombre");
      const description = escapeHtml(getLocationDescription(location));
      const available = hasCoordinates(location);

      return `
        <button
          type="button"
          class="map-location-item"
          data-location-id="${escapeHtml(location.id ?? "")}"
          ${available ? "" : "disabled"}
        >
          <strong>${name}</strong>
          <span>${description}</span>
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

    const locationId = String(id);
    let marker = markersById.get(locationId);

    if (!marker) {
      const location = allLocations.find(
        item => String(item.id) === locationId
      );

      if (!location || !hasCoordinates(location)) {
        return false;
      }

      state.city = "all";
      state.search = "";

      const citySelect = getElement("mapCityFilter");
      const searchInput = getElement("mapSearch");

      if (citySelect) citySelect.value = "all";
      if (searchInput) searchInput.value = "";

      renderMarkers();
      marker = markersById.get(locationId);
    }

    if (!marker || !map) return false;

    map.setView(marker.getLatLng(), 15);
    marker.openPopup();

    return true;
  }

  // ------------------------------------------------------------
  // ORIGEN LIBRE Y SUGERENCIAS
  // ------------------------------------------------------------

  function ensureSuggestionPanel() {
    const input = getElement("routeOrigin");

    if (!input || suggestionPanel) return;

    suggestionPanel = document.createElement("div");
    suggestionPanel.id = "routeOriginSuggestionsPanel";

    Object.assign(suggestionPanel.style, {
      display: "none",
      position: "absolute",
      top: "calc(100% + 4px)",
      left: "0",
      right: "0",
      zIndex: "2000",
      maxHeight: "280px",
      overflowY: "auto",
      background: "#fffdf8",
      border: "1px solid #c9d0ca",
      borderRadius: "8px",
      boxShadow: "0 5px 16px #00000018"
    });

    const field = input.closest(".field");

    if (field) {
      field.style.position = "relative";
      field.appendChild(suggestionPanel);
    }
  }

  function hideSuggestions() {
    if (suggestionPanel) {
      suggestionPanel.style.display = "none";
      suggestionPanel.innerHTML = "";
    }
  }

  function addSuggestionMessage(message) {
    if (!suggestionPanel) return;

    suggestionPanel.innerHTML = "";

    const item = document.createElement("div");

    Object.assign(item.style, {
      padding: "11px 12px",
      color: "#68766f",
      fontSize: "0.9rem"
    });

    item.textContent = message;
    suggestionPanel.appendChild(item);
    suggestionPanel.style.display = "block";
  }

  function renderSuggestions(items, messageIfEmpty) {
    if (!suggestionPanel) return;

    suggestionPanel.innerHTML = "";

    if (!items.length) {
      addSuggestionMessage(
        messageIfEmpty || "No se encontraron lugares."
      );
      return;
    }

    items.forEach(item => {
      const button = document.createElement("button");

      button.type = "button";
      button.textContent = item.label;

      Object.assign(button.style, {
        display: "block",
        width: "100%",
        padding: "11px 12px",
        textAlign: "left",
        color: "#25332e",
        background: "#fffdf8",
        border: "0",
        borderBottom: "1px solid #e3e1d7",
        cursor: "pointer",
        fontSize: "0.92rem",
        overflowWrap: "anywhere"
      });

      button.addEventListener("mouseenter", function () {
        button.style.background = "#e9eee7";
      });

      button.addEventListener("mouseleave", function () {
        button.style.background = "#fffdf8";
      });

      button.addEventListener("click", function () {
        chooseOrigin(item);
      });

      suggestionPanel.appendChild(button);
    });

    suggestionPanel.style.display = "block";
  }

  function chooseOrigin(origin) {
    const input = getElement("routeOrigin");

    if (!input) return;

    selectedOrigin = {
      ...origin,
      latitude: Number(origin.latitude),
      longitude: Number(origin.longitude)
    };

    input.value = origin.label || getOriginLabel(selectedOrigin);

    hideSuggestions();

    showRouteStatus(
      `Origen seleccionado: ${getOriginLabel(selectedOrigin)}. Ahora elige el destino y calcula la ruta.`
    );

    if (currentRoute) {
      clearRoute({ showStatus: false });
    }
  }

  function getLocalSuggestions(query) {
    const normalizedQuery = normalizeText(query);

    return allLocations
      .filter(location => {
        if (!hasCoordinates(location)) return false;

        return [
          location.name,
          location.address,
          location.city,
          location.country
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
        latitude: location.latitude,
        longitude: location.longitude,
        label: getLocationLabel(location),
        source: "itinerary"
      }));
  }

  function getPhotonCoordinates(feature) {
    const coordinates = feature &&
      feature.geometry &&
      feature.geometry.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    // GeoJSON utiliza [longitud, latitud].
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);

    const location = { latitude, longitude };

    return hasCoordinates(location) ? location : null;
  }

  function mapPhotonFeature(feature) {
    const coordinates = getPhotonCoordinates(feature);

    if (!coordinates) return null;

    const label = createExternalLabel(feature);

    return {
      ...label,
      address: [
        feature.properties && feature.properties.street,
        feature.properties && feature.properties.housenumber
      ].filter(Boolean).join(" "),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      source: "photon"
    };
  }

  async function searchPhoton(query, sequence) {
    const url = new URL(CONFIG.photonUrl);

    url.searchParams.set("q", query);
    url.searchParams.set("limit", "6");
    url.searchParams.set("lang", "es");

    if (searchController) {
      searchController.abort();
    }

    searchController = new AbortController();

    // Evitar solicitudes demasiado frecuentes al servicio público.
    const elapsed = Date.now() - lastPhotonRequestAt;
    const wait = Math.max(0, 1000 - elapsed);

    if (wait) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    if (sequence !== searchSequence) return [];

    lastPhotonRequestAt = Date.now();

    const response = await fetch(url.toString(), {
      signal: searchController.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`El buscador respondió HTTP ${response.status}.`);
    }

    const data = await response.json();

    if (sequence !== searchSequence) return [];

    return (data.features || [])
      .map(mapPhotonFeature)
      .filter(Boolean);
  }

  async function performOriginSearch(query, sequence) {
    const localResults = getLocalSuggestions(query);

    // Mostrar primero los resultados locales del itinerario.
    if (localResults.length) {
      renderSuggestions(localResults, "");
    } else {
      addSuggestionMessage("Buscando lugares…");
    }

    try {
      const remoteResults = await searchPhoton(query, sequence);

      if (sequence !== searchSequence) return;

      const combined = [...localResults];
      const seen = new Set(
        combined.map(item =>
          `${normalizeText(item.name)}|${item.latitude.toFixed(5)}|${item.longitude.toFixed(5)}`
        )
      );

      remoteResults.forEach(item => {
        const key =
          `${normalizeText(item.name)}|${item.latitude.toFixed(5)}|${item.longitude.toFixed(5)}`;

        if (!seen.has(key)) {
          seen.add(key);
          combined.push(item);
        }
      });

      renderSuggestions(
        combined.slice(0, CONFIG.maximumSuggestions),
        "No se encontraron lugares. Prueba con una dirección más completa."
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      console.warn("No fue posible consultar Photon:", error);

      if (sequence !== searchSequence) return;

      renderSuggestions(
        localResults,
        localResults.length
          ? "No se pudo consultar el buscador externo. Puedes elegir un lugar del itinerario."
          : "No se pudo consultar el buscador. Comprueba tu conexión o introduce coordenadas."
      );
    }
  }

  function connectOriginSearch() {
    const input = getElement("routeOrigin");

    if (!input) return;

    ensureSuggestionPanel();

    input.addEventListener("input", function () {
      selectedOrigin = null;

      if (currentRoute) {
        clearRoute({ showStatus: false });
      }

      if (searchTimer) {
        clearTimeout(searchTimer);
      }

      searchSequence += 1;
      const sequence = searchSequence;
      const query = input.value.trim();

      if (searchController) {
        searchController.abort();
      }

      if (query.length < CONFIG.minimumSearchLength) {
        const localResults = query
          ? getLocalSuggestions(query)
          : [];

        if (localResults.length) {
          renderSuggestions(localResults, "");
        } else {
          hideSuggestions();
        }

        return;
      }

      searchTimer = setTimeout(function () {
        performOriginSearch(query, sequence);
      }, CONFIG.searchDelay);
    });

    input.addEventListener("focus", function () {
      const query = input.value.trim();

      if (query.length >= CONFIG.minimumSearchLength) {
        input.dispatchEvent(new Event("input"));
      }
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        hideSuggestions();
      }

      if (event.key === "Enter") {
        event.preventDefault();

        const firstButton = suggestionPanel &&
          suggestionPanel.querySelector("button");

        if (
          suggestionPanel &&
          suggestionPanel.style.display !== "none" &&
          firstButton
        ) {
          firstButton.click();
        } else {
          hideSuggestions();
          showRouteStatus(
            "Si escribiste una dirección, pulsa «Calcular ruta» para buscarla. También puedes escribir latitud, longitud."
          );
        }
      }
    });

    document.addEventListener("click", function (event) {
      if (
        suggestionPanel &&
        !suggestionPanel.contains(event.target) &&
        event.target !== input
      ) {
        hideSuggestions();
      }
    });
  }

  // ------------------------------------------------------------
  // RESOLVER EL ORIGEN
  // ------------------------------------------------------------

  function parseCoordinates(text) {
    const parts = String(text)
      .trim()
      .split(/[;,]/)
      .map(part => part.trim());

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
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

      const candidates = [
        getLocationLabel(location),
        location.name,
        location.address
      ];

      return candidates.some(value =>
        normalizeText(value) === query
      );
    }) || null;
  }

  async function resolveOrigin() {
    const input = getElement("routeOrigin");
    const text = input ? input.value.trim() : "";

    if (!text) {
      throw new Error("Escribe un lugar o unas coordenadas para el origen.");
    }

    // Si el usuario eligió una sugerencia, usar esas coordenadas.
    if (
      selectedOrigin &&
      normalizeText(selectedOrigin.label) === normalizeText(text) &&
      hasCoordinates(selectedOrigin)
    ) {
      return selectedOrigin;
    }

    // Aceptar coordenadas manuales: latitud, longitud.
    const coordinates = parseCoordinates(text);

    if (coordinates) {
      return {
        name: "Coordenadas manuales",
        label: `Coordenadas: ${coordinates.latitude}, ${coordinates.longitude}`,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        source: "coordinates"
      };
    }

    // Intentar encontrar una coincidencia exacta del itinerario.
    const local = findExactLocalLocation(text);

    if (local) {
      return makeOrigin(local);
    }

    // Si es una dirección o un lugar externo, buscarlo en Photon.
    showRouteStatus("Buscando las coordenadas del origen…");

    const results = await searchPhoton(text, ++searchSequence);

    if (!results.length) {
      throw new Error(
        "No se encontró el origen. Prueba con el nombre y la ciudad, selecciona una sugerencia o introduce latitud, longitud."
      );
    }

    // Una consulta explícita al calcular ruta usa el primer resultado.
    // Si hay ambigüedad, conviene elegir la sugerencia correcta.
    if (results.length > 1) {
      const inputElement = getElement("routeOrigin");

      if (inputElement) {
        renderSuggestions(results, "");
        showRouteStatus(
          "Se encontraron varios lugares. Selecciona la sugerencia correcta antes de calcular la ruta."
        );
      }

      throw new Error(
        "Hay varias coincidencias posibles. Selecciona el lugar correcto en las sugerencias."
      );
    }

    const result = results[0];

    selectedOrigin = result;

    if (input) {
      input.value = result.label;
    }

    hideSuggestions();

    return result;
  }

  // ------------------------------------------------------------
  // DESTINO Y CONTROLES DE RUTA
  // ------------------------------------------------------------

  function getRoutableLocations() {
    return allLocations
      .filter(hasCoordinates)
      .slice()
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
  }

  function populateRouteSelectors() {
    const destinationSelect = getElement("routeDestination");

    if (!destinationSelect) return;

    const locations = getRoutableLocations();

    destinationSelect.innerHTML = [
      '<option value="">Selecciona el destino</option>',
      ...locations.map(location => `
        <option value="${escapeHtml(location.id ?? "")}">
          ${escapeHtml(getLocationLabel(location))}
        </option>
      `)
    ].join("");

    destinationSelect.disabled = locations.length === 0;

    const calculateButton = getElement("calculateRoute");

    if (calculateButton) {
      calculateButton.disabled = locations.length === 0;
    }

    // Llenar datalist por compatibilidad con el HTML.
    const datalist = getElement("routeOriginSuggestions");

    if (datalist) {
      datalist.innerHTML = locations.map(location => `
        <option value="${escapeHtml(getLocationLabel(location))}"></option>
      `).join("");
    }

    if (!locations.length) {
      showRouteStatus(
        "No hay destinos con coordenadas válidas. Revisa locations.json."
      );
    } else {
      showRouteStatus(
        `${locations.length} destinos disponibles. Escribe un origen o selecciona una sugerencia.`
      );
    }
  }

  function findLocationById(id) {
    return allLocations.find(
      location =>
        location.id !== undefined &&
        location.id !== null &&
        String(location.id) === String(id)
    );
  }

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

    const originName = escapeHtml(getOriginLabel(origin));
    const destinationName = escapeHtml(getLocationLabel(destination));
    const distance = escapeHtml(formatDistance(route.distance));
    const duration = escapeHtml(formatDuration(route.duration));
    const modeLabel = mode === "walking" ? "A pie" : "Automóvil";

    summary.innerHTML = `
      <p class="route-summary-title">Ruta calculada</p>
      <p class="route-summary-detail"><strong>Transporte:</strong> ${modeLabel}</p>
      <p class="route-summary-detail"><strong>Origen:</strong> ${originName}</p>
      <p class="route-summary-detail"><strong>Destino:</strong> ${destinationName}</p>
      <p class="route-summary-detail"><strong>Distancia:</strong> ${distance}</p>
      <p class="route-summary-detail"><strong>Tiempo estimado:</strong> ${duration}</p>
      <p class="route-summary-warning">
        Tiempo estimado según el modelo de rutas; no representa tráfico
        en tiempo real. La disponibilidad depende de la cobertura del servicio.
      </p>
    `;
  }

  function clearRoute(options = {}) {
    if (routeLayer) {
      routeLayer.clearLayers();
    }

    currentRoute = null;

    const summary = getElement("routeSummary");

    if (summary) {
      summary.innerHTML = "";
    }

    if (options.showStatus !== false) {
      showRouteStatus(
        "Ruta eliminada. Puedes elegir otros puntos y calcular una nueva."
      );
    }
  }

  async function calculateRoute() {
    if (routeRequestInProgress) return;

    const destinationSelect = getElement("routeDestination");
    const modeSelect = getElement("routeMode");
    const calculateButton = getElement("calculateRoute");

    if (!destinationSelect) {
      showRouteStatus("No se encontró el campo de destino.");
      return;
    }

    const destinationId = destinationSelect.value;

    if (!destinationId) {
      showRouteStatus("Selecciona un destino del itinerario.");
      return;
    }

    const destination = findLocationById(destinationId);

    if (!destination || !hasCoordinates(destination)) {
      showRouteStatus(
        "El destino seleccionado no tiene coordenadas válidas."
      );
      return;
    }

    const mode = modeSelect && modeSelect.value === "walking"
      ? "walking"
      : "driving";

    routeRequestInProgress = true;

    if (calculateButton) {
      calculateButton.disabled = true;
    }

    clearRoute({ showStatus: false });

    try {
      const origin = await resolveOrigin();

      if (!hasCoordinates(origin)) {
        throw new Error("El origen no contiene coordenadas válidas.");
      }

      if (
        Math.abs(origin.latitude - destination.latitude) < 0.000001 &&
        Math.abs(origin.longitude - destination.longitude) < 0.000001
      ) {
        throw new Error(
          "El origen y el destino son el mismo punto. Selecciona otro destino."
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

      // OSRM espera longitud,latitud.
      const coordinates = [
        `${origin.longitude},${origin.latitude}`,
        `${destination.longitude},${destination.latitude}`
      ].join(";");

      const url =
        `${routeBase}/${coordinates}` +
        "?overview=full&geometries=geojson&steps=false";

      const response = await fetch(url, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(
          `El servicio de rutas respondió HTTP ${response.status}.`
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
          "No se encontró una ruta entre esos puntos. Revisa las coordenadas o intenta con otro punto cercano."
        );
      }

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

      const originMarker = L.circleMarker(
        [origin.latitude, origin.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#238443",
          fillOpacity: 1
        }
      );

      originMarker.bindPopup(
        `<strong>Origen:</strong> ${escapeHtml(getOriginLabel(origin))}`
      );

      originMarker.addTo(routeLayer);

      const destinationMarker = L.circleMarker(
        [destination.latitude, destination.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2459a6",
          fillOpacity: 1
        }
      );

      destinationMarker.bindPopup(
        `<strong>Destino:</strong> ${escapeHtml(getLocationLabel(destination))}`
      );

      destinationMarker.addTo(routeLayer);

      const routeBounds = routeLine.getBounds();

      if (routeBounds.isValid()) {
        map.fitBounds(routeBounds, {
          padding: [35, 35],
          maxZoom: 16
        });
      }

      currentRoute = {
        origin: makeOrigin(origin),
        destinationId: destination.id,
        mode,
        distance: route.distance,
        duration: route.duration
      };

      renderRouteSummary(origin, destination, route, mode);

      showRouteStatus("Ruta calculada correctamente.");
    } catch (error) {
      console.error("Error al calcular la ruta:", error);

      showRouteStatus(
        error.message ||
        "No se pudo calcular la ruta. Comprueba tu conexión e inténtalo de nuevo."
      );
    } finally {
      routeRequestInProgress = false;

      if (calculateButton) {
        calculateButton.disabled = false;
      }
    }
  }

  function connectRouteControls() {
    const calculateButton = getElement("calculateRoute");
    const clearButton = getElement("clearRoute");
    const destinationSelect = getElement("routeDestination");

    if (calculateButton) {
      calculateButton.addEventListener("click", calculateRoute);
    }

    if (clearButton) {
      clearButton.addEventListener("click", function () {
        clearRoute();
      });
    }

    if (destinationSelect) {
      destinationSelect.addEventListener("change", function () {
        if (currentRoute) {
          clearRoute({ showStatus: false });

          showRouteStatus(
            "Cambiaste el destino. Pulsa «Calcular ruta» para actualizar el recorrido."
          );
        }
      });
    }

    connectOriginSearch();
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

      if (requestedLocation) {
        const found = showLocation(requestedLocation);

        if (!found) {
          showStatus(
            "No se encontró el marcador solicitado. Revisa el ID y las coordenadas en locations.json."
          );
        }
      }

      if (!allLocations.length) {
        showStatus("No se encontraron ubicaciones en el archivo.");
      } else if (!allLocations.some(hasCoordinates)) {
        showStatus(
          "Las ubicaciones se cargaron, pero ninguna tiene coordenadas válidas."
        );
      }
    } catch (error) {
      console.error("Error al cargar las ubicaciones:", error);

      showStatus(
        "No se pudieron cargar las ubicaciones. Verifica la ruta y el formato de locations.json."
      );

      showRouteStatus(
        "No se pueden calcular rutas porque no se cargaron las ubicaciones."
      );
    }
  }

  // ------------------------------------------------------------
  // INICIO Y API PÚBLICA
  // ------------------------------------------------------------

  function start() {
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
