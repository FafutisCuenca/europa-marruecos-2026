
/*
 * Europa + Marruecos 2026
 * Archivo: js/map.js
 *
 * Funciones:
 * - Mapa interactivo con Leaflet.
 * - Filtros por ciudad y texto.
 * - Apertura de ubicaciones desde el itinerario.
 * - Origen y destino con búsqueda libre y sugerencias.
 * - Búsqueda local en locations.json y externa con Photon.
 * - Coordenadas manuales: latitud, longitud.
 * - Rutas en automóvil y a pie.
 * - Distancia, duración estimada y limpieza de rutas.
 *
 * Servicios públicos:
 * - Photon: búsqueda geográfica.
 * - OpenStreetMap: mapa base.
 * - OSRM público de FOSSGIS: cálculo de rutas.
 *
 * Requiere conexión a internet.
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
    photonMinimumInterval: 1000
  };

  let map = null;
  let markerLayer = null;
  let routeLayer = null;

  let allLocations = [];
  let markersById = new Map();

  let currentRoute = null;
  let routeRequestInProgress = false;

  // Origen y destino elegidos por el usuario.
  let selectedOrigin = null;
  let selectedDestination = null;

  // Estado independiente para las búsquedas de origen y destino.
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
      Number.isFinite(Number(location.latitude)) &&
      Number.isFinite(Number(location.longitude)) &&
      location.latitude !== "" &&
      location.longitude !== "" &&
      Number(location.latitude) >= -90 &&
      Number(location.latitude) <= 90 &&
      Number(location.longitude) >= -180 &&
      Number(location.longitude) <= 180
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
    return origin && origin.label
      ? origin.label
      : getLocationLabel(origin || {});
  }

  function getDestinationLabel(destination) {
    return destination && destination.label
      ? destination.label
      : getLocationLabel(destination || {});
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
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      label: location.label || getLocationLabel(location),
      source: location.source || "itinerary"
    };
  }

  function makeDestination(location) {
    return {
      id: location.id ?? null,
      name: location.name || "Destino",
      address: location.address || "",
      city: location.city || "",
      country: location.country || "",
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      label: location.label || getLocationLabel(location),
      source: location.source || "itinerary"
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
  // CONVERTIR DESTINO SELECT A CAMPO DE TEXTO
  // ------------------------------------------------------------

  function prepareDestinationInput() {
    const existing = getElement("routeDestination");

    if (!existing || existing.tagName === "INPUT") return;

    const input = document.createElement("input");

    input.type = "text";
    input.id = "routeDestination";
    input.name = existing.name || "routeDestination";
    input.placeholder = "Escribe un destino o selecciona una sugerencia";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Punto de destino");
    input.setAttribute("aria-autocomplete", "list");

    // Conservar las clases visuales del selector original.
    input.className = existing.className || "";

    existing.replaceWith(input);
  }

  // ------------------------------------------------------------
  // BÚSQUEDA Y SUGERENCIAS PARA ORIGEN Y DESTINO
  // ------------------------------------------------------------

  function ensureSuggestionPanel(type) {
    const inputId = type === "origin"
      ? "routeOrigin"
      : "routeDestination";

    const input = getElement(inputId);

    if (!input || searches[type].panel) return;

    const panel = document.createElement("div");
    panel.id = type === "origin"
      ? "routeOriginSuggestionsPanel"
      : "routeDestinationSuggestionsPanel";

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
      field.style.position = "relative";
      field.appendChild(panel);
    } else {
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

  function addSuggestionMessage(type, message) {
    const panel = searches[type].panel;

    if (!panel) return;

    panel.innerHTML = "";

    const item = document.createElement("div");

    Object.assign(item.style, {
      padding: "11px 12px",
      color: "#68766f",
      fontSize: "0.9rem"
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
      addSuggestionMessage(
        type,
        messageIfEmpty || "No se encontraron lugares."
      );
      return;
    }

    items.forEach(item => {
      const button = document.createElement("button");

      button.type = "button";
      button.textContent = item.label;
      button.setAttribute("role", "option");

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

    if (!input) return;

    const chosen = {
      ...item,
      latitude: Number(item.latitude),
      longitude: Number(item.longitude)
    };

    if (type === "origin") {
      selectedOrigin = chosen;
      input.value = chosen.label || getOriginLabel(chosen);
    } else {
      selectedDestination = chosen;
      input.value = chosen.label || getDestinationLabel(chosen);
    }

    hideSuggestions(type);

    if (currentRoute) {
      clearRoute({ showStatus: false });
    }

    showRouteStatus(
      `${type === "origin" ? "Origen" : "Destino"} seleccionado: ${chosen.label}. Pulsa «Calcular ruta» para continuar.`
    );
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
    const properties = feature.properties || {};

    return {
      ...label,
      address: [
        properties.street,
        properties.housenumber
      ].filter(Boolean).join(" "),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      source: "photon"
    };
  }

  async function searchPhoton(query, type, sequence) {
    const searchState = searches[type];

    const url = new URL(CONFIG.photonUrl);

    url.searchParams.set("q", query);
    url.searchParams.set("limit", "6");
    url.searchParams.set("lang", "es");

    if (searchState.controller) {
      searchState.controller.abort();
    }

    const controller = new AbortController();
    searchState.controller = controller;

    const elapsed = Date.now() - searchState.lastPhotonRequestAt;
    const wait = Math.max(
      0,
      CONFIG.photonMinimumInterval - elapsed
    );

    if (wait) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    if (sequence !== searchState.sequence) return [];

    searchState.lastPhotonRequestAt = Date.now();

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `El buscador respondió HTTP ${response.status}.`
      );
    }

    const data = await response.json();

    if (sequence !== searchState.sequence) return [];

    return (data.features || [])
      .map(mapPhotonFeature)
      .filter(Boolean);
  }

  async function performSearch(type, query, sequence) {
    const localResults = getLocalSuggestions(query);

    if (localResults.length) {
      renderSuggestions(type, localResults, "");
    } else {
      addSuggestionMessage(type, "Buscando lugares…");
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
        type,
        combined.slice(0, CONFIG.maximumSuggestions),
        "No se encontraron lugares. Prueba con un nombre más completo o incluye la ciudad."
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      console.warn(
        `No fue posible consultar Photon para ${type}:`,
        error
      );

      if (sequence !== searches[type].sequence) return;

      renderSuggestions(
        type,
        localResults,
        localResults.length
          ? "No se pudo consultar el buscador externo. Puedes elegir un lugar del itinerario."
          : "No se pudo consultar el buscador. Comprueba tu conexión o introduce latitud, longitud."
      );
    }
  }

  function connectSearch(type) {
    const inputId = type === "origin"
      ? "routeOrigin"
      : "routeDestination";

    const input = getElement(inputId);

    if (!input) return;

    ensureSuggestionPanel(type);

    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-autocomplete", "list");

    input.addEventListener("input", function () {
      if (type === "origin") {
        selectedOrigin = null;
      } else {
        selectedDestination = null;
      }

      if (currentRoute) {
        clearRoute({ showStatus: false });
      }

      const searchState = searches[type];

      if (searchState.timer) {
        clearTimeout(searchState.timer);
      }

      searchState.sequence += 1;
      const sequence = searchState.sequence;
      const query = input.value.trim();

      if (searchState.controller) {
        searchState.controller.abort();
      }

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

      searchState.timer = setTimeout(function () {
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
        event.preventDefault();

        const firstButton = panel && panel.querySelector("button");

        if (
          panel &&
          panel.style.display !== "none" &&
          firstButton
        ) {
          firstButton.click();
        } else {
          hideSuggestions(type);

          showRouteStatus(
            "Selecciona una sugerencia o introduce las coordenadas como latitud, longitud."
          );
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

  async function resolvePoint(type) {
    const isOrigin = type === "origin";
    const input = getElement(
      isOrigin ? "routeOrigin" : "routeDestination"
    );

    const text = input ? input.value.trim() : "";
    const selected = isOrigin
      ? selectedOrigin
      : selectedDestination;

    if (!text) {
      throw new Error(
        `Escribe un lugar o unas coordenadas para el ${isOrigin ? "origen" : "destino"}.`
      );
    }

    // Usar las coordenadas exactas de la sugerencia seleccionada.
    if (
      selected &&
      normalizeText(selected.label) === normalizeText(text) &&
      hasCoordinates(selected)
    ) {
      return selected;
    }

    // Aceptar coordenadas introducidas manualmente.
    const coordinates = parseCoordinates(text);

    if (coordinates) {
      const result = {
        name: isOrigin ? "Origen por coordenadas" : "Destino por coordenadas",
        label: `Coordenadas: ${coordinates.latitude}, ${coordinates.longitude}`,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        source: "coordinates"
      };

      if (isOrigin) {
        selectedOrigin = result;
      } else {
        selectedDestination = result;
      }

      return result;
    }

    // Buscar coincidencia exacta en el itinerario.
    const local = findExactLocalLocation(text);

    if (local) {
      const result = isOrigin
        ? makeOrigin(local)
        : makeDestination(local);

      if (isOrigin) {
        selectedOrigin = result;
      } else {
        selectedDestination = result;
      }

      return result;
    }

    // Si no coincide con el itinerario, consultar Photon.
    showRouteStatus(
      `Buscando las coordenadas del ${isOrigin ? "origen" : "destino"}…`
    );

    const sequence = ++searches[type].sequence;
    const results = await searchPhoton(text, type, sequence);

    if (!results.length) {
      throw new Error(
        `No se encontró el ${isOrigin ? "origen" : "destino"}. Prueba con el nombre y la ciudad, selecciona una sugerencia o introduce latitud, longitud.`
      );
    }

    if (results.length > 1) {
      renderSuggestions(type, results, "");

      showRouteStatus(
        `Se encontraron varias coincidencias para el ${isOrigin ? "origen" : "destino"}. Selecciona la correcta en las sugerencias.`
      );

      throw new Error(
        `Hay varias coincidencias para el ${isOrigin ? "origen" : "destino"}. Selecciona el lugar correcto en las sugerencias.`
      );
    }

    const result = results[0];

    if (isOrigin) {
      selectedOrigin = result;
    } else {
      selectedDestination = result;
    }

    if (input) {
      input.value = result.label;
    }

    hideSuggestions(type);

    return result;
  }

  // ------------------------------------------------------------
  // CONTROLES Y DATOS DEL ITINERARIO
  // ------------------------------------------------------------

  function populateRouteSelectors() {
    // routeDestination ahora es un campo de texto, no un selector.
    const destinationInput = getElement("routeDestination");
    const originInput = getElement("routeOrigin");

    const locations = allLocations.filter(hasCoordinates);

    if (destinationInput) {
      destinationInput.disabled = false;
    }

    if (originInput) {
      originInput.disabled = false;
    }

    const calculateButton = getElement("calculateRoute");

    if (calculateButton) {
      calculateButton.disabled = false;
    }

    // Se conserva el datalist de origen si existe.
    const datalist = getElement("routeOriginSuggestions");

    if (datalist) {
      datalist.innerHTML = locations.map(location => `
        <option value="${escapeHtml(getLocationLabel(location))}"></option>
      `).join("");
    }

    if (!locations.length) {
      showRouteStatus(
        "No hay ubicaciones con coordenadas válidas en locations.json. Puedes introducir un origen y un destino mediante coordenadas."
      );
    } else {
      showRouteStatus(
        `${locations.length} lugares del itinerario disponibles como sugerencias. También puedes buscar lugares externos.`
      );
    }
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
    const destinationName = escapeHtml(
      getDestinationLabel(destination)
    );
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

  // ------------------------------------------------------------
  // CÁLCULO DE RUTA
  // ------------------------------------------------------------

  async function calculateRoute() {
    if (routeRequestInProgress) return;

    const modeSelect = getElement("routeMode");
    const calculateButton = getElement("calculateRoute");

    const originInput = getElement("routeOrigin");
    const destinationInput = getElement("routeDestination");

    if (!originInput || !destinationInput) {
      showRouteStatus(
        "No se encontraron los campos de origen y destino."
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

    const mode = modeSelect && modeSelect.value === "walking"
      ? "walking"
      : "driving";

    routeRequestInProgress = true;

    if (calculateButton) {
      calculateButton.disabled = true;
    }

    clearRoute({ showStatus: false });

    try {
      const origin = await resolvePoint("origin");
      const destination = await resolvePoint("destination");

      if (!hasCoordinates(origin)) {
        throw new Error("El origen no contiene coordenadas válidas.");
      }

      if (!hasCoordinates(destination)) {
        throw new Error("El destino no contiene coordenadas válidas.");
      }

      if (
        Math.abs(Number(origin.latitude) - Number(destination.latitude)) < 0.000001 &&
        Math.abs(Number(origin.longitude) - Number(destination.longitude)) < 0.000001
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
          "No se encontró una ruta entre esos puntos. Revisa las ubicaciones o intenta con un punto cercano."
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
        [Number(origin.latitude), Number(origin.longitude)],
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
        [Number(destination.latitude), Number(destination.longitude)],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2459a6",
          fillOpacity: 1
        }
      );

      destinationMarker.bindPopup(
        `<strong>Destino:</strong> ${escapeHtml(getDestinationLabel(destination))}`
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
        destination: makeDestination(destination),
        mode,
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry
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

    if (calculateButton) {
      calculateButton.addEventListener("click", calculateRoute);
    }

    if (clearButton) {
      clearButton.addEventListener("click", function () {
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
    // Convertir el destino antes de conectar sus eventos.
    prepareDestinationInput();

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
