
/*
 * Europa + Marruecos 2026
 * Archivo: js/map.js
 * Funciones:
 * - Mostrar ubicaciones del viaje en Leaflet.
 * - Filtrar ubicaciones por ciudad y texto.
 * - Abrir ubicaciones desde enlaces del itinerario.
 * - Calcular rutas por calles mediante OSRM.
 * - Mostrar distancia y duración estimada.
 *
 * Dependencias:
 * - Leaflet debe cargarse previamente en mapa.html.
 * - Internet para los mapas y el servicio OSRM.
 * - OSRM público: rutas para automóvil.
 */

(function () {
  "use strict";

  const CONFIG = {
    locationsUrl: "./data/locations.json",
    defaultCenter: [40.4168, -3.7038],
    defaultZoom: 5,
    osrmUrl: "https://router.project-osrm.org/route/v1/driving",
    routeColor: "#d34b35"
  };

  let map = null;
  let markerLayer = null;
  let routeLayer = null;
  let allLocations = [];
  let markersById = new Map();
  let currentRoute = null;
  let routeRequestInProgress = false;

  const state = {
    city: "all",
    search: ""
  };

  function getElement(id) {
    return document.getElementById(id);
  }

  function hasCoordinates(location) {
    return (
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

  function createPopup(location) {
    const name = escapeHtml(location.name || "Ubicación");
    const description = escapeHtml(getLocationDescription(location));
    const type = escapeHtml(location.type || "Lugar del itinerario");

    return `
      <div class="trip-map-popup">
        <strong>${name}</strong>
        <div>${description}</div>
        <small>${type}</small>
      </div>
    `;
  }

  function showStatus(message) {
    const statusElement = getElement("mapStatus");

    if (statusElement) {
      statusElement.textContent = message;
    }
  }

  function showRouteStatus(message) {
    const statusElement = getElement("routeStatus");

    if (statusElement) {
      statusElement.textContent = message;
    }
  }

  function initializeMap() {
    const mapElement = getElement("tripMap");

    if (!mapElement) {
      console.error(
        "Mapa no inicializado: falta un elemento con id='tripMap'."
      );
      showStatus("No se encontró el contenedor del mapa en mapa.html.");
      return false;
    }

    if (typeof L === "undefined") {
      showStatus(
        "No se pudo cargar Leaflet. Revisa la conexión y las referencias de mapa.html."
      );
      console.error("Leaflet no está disponible.");
      return false;
    }

    map = L.map(mapElement).setView(
      CONFIG.defaultCenter,
      CONFIG.defaultZoom
    );

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    return true;
  }

  function renderCityOptions() {
    const select = getElement("mapCityFilter");

    if (!select) {
      return;
    }

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

    const query = state.search.trim().toLocaleLowerCase("es");

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
        .some(value =>
          String(value).toLocaleLowerCase("es").includes(query)
        );

    return cityMatches && searchMatches;
  }

  function renderMarkers() {
    if (!map || !markerLayer) {
      return;
    }

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

    if (bounds.length > 0) {
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

    if (!list) {
      return;
    }

    const locations = allLocations
      .filter(matchesFilters)
      .sort((a, b) => {
        const cityCompare = String(a.city || "").localeCompare(
          String(b.city || ""),
          "es"
        );

        return cityCompare ||
          String(a.name || "").localeCompare(String(b.name || ""), "es");
      });

    if (locations.length === 0) {
      list.innerHTML =
        "<p>No hay ubicaciones que coincidan con el filtro.</p>";
      return;
    }

    list.innerHTML = locations.map(location => {
      const name = escapeHtml(location.name || "Ubicación sin nombre");
      const description = escapeHtml(getLocationDescription(location));
      const hasMarker = hasCoordinates(location);
      const pendingLabel = hasMarker
        ? ""
        : '<span class="map-pending">Ubicación por confirmar</span>';

      return `
        <button
          type="button"
          class="map-location-item"
          data-location-id="${escapeHtml(location.id ?? "")}"
          ${hasMarker ? "" : "disabled"}
        >
          <strong>${name}</strong>
          <span>${description}</span>
          ${pendingLabel}
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

    // Si un filtro oculta la ubicación, quitar los filtros y buscarla otra vez.
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

      if (citySelect) {
        citySelect.value = "all";
      }

      if (searchInput) {
        searchInput.value = "";
      }

      renderMarkers();
      marker = markersById.get(locationId);
    }

    if (!marker || !map) {
      return false;
    }

    map.setView(marker.getLatLng(), 15);
    marker.openPopup();

    return true;
  }

  // ------------------------------------------------------------
  // PLANIFICADOR DE RUTAS
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
          String(a.name || "").localeCompare(String(b.name || ""), "es");
      });
  }

  function populateRouteSelectors() {
    const originSelect = getElement("routeOrigin");
    const destinationSelect = getElement("routeDestination");

    if (!originSelect || !destinationSelect) {
      return;
    }

    const locations = getRoutableLocations();

    const options = [
      '<option value="">Selecciona una ubicación</option>',
      ...locations.map(location => {
        const id = escapeHtml(location.id ?? "");
        const label = escapeHtml(getLocationLabel(location));

        return `<option value="${id}">${label}</option>`;
      })
    ].join("");

    originSelect.innerHTML = options;
    destinationSelect.innerHTML = options;

    originSelect.disabled = locations.length < 2;
    destinationSelect.disabled = locations.length < 2;

    const calculateButton = getElement("calculateRoute");

    if (calculateButton) {
      calculateButton.disabled = locations.length < 2;
    }

    if (locations.length < 2) {
      showRouteStatus(
        "Se necesitan al menos dos ubicaciones con coordenadas válidas para calcular una ruta."
      );
      return;
    }

    // No seleccionamos automáticamente el origen ni el destino:
    // el usuario elige los puntos que desea conectar.
    showRouteStatus(
      `${locations.length} ubicaciones disponibles para calcular rutas en automóvil.`
    );
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

    if (hours === 0) {
      return `${totalMinutes} min`;
    }

    if (minutes === 0) {
      return `${hours} h`;
    }

    return `${hours} h ${minutes} min`;
  }

  function renderRouteSummary(origin, destination, route) {
    const summary = getElement("routeSummary");

    if (!summary) {
      return;
    }

    const originName = escapeHtml(getLocationLabel(origin));
    const destinationName = escapeHtml(getLocationLabel(destination));
    const distance = escapeHtml(formatDistance(route.distance));
    const duration = escapeHtml(formatDuration(route.duration));

    summary.innerHTML = `
      <p class="route-summary-title">Ruta calculada</p>
      <p class="route-summary-detail"><strong>Origen:</strong> ${originName}</p>
      <p class="route-summary-detail"><strong>Destino:</strong> ${destinationName}</p>
      <p class="route-summary-detail"><strong>Distancia:</strong> ${distance}</p>
      <p class="route-summary-detail"><strong>Tiempo estimado:</strong> ${duration}</p>
      <p class="route-summary-warning">
        Estimación para automóvil. No representa el tráfico en tiempo real.
        La ruta depende de la cobertura de calles disponible en OSRM.
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
        "Ruta eliminada. Selecciona un origen y un destino para calcular otra."
      );
    }
  }

  async function calculateRoute() {
    if (routeRequestInProgress) {
      return;
    }

    const originSelect = getElement("routeOrigin");
    const destinationSelect = getElement("routeDestination");
    const calculateButton = getElement("calculateRoute");

    if (!originSelect || !destinationSelect) {
      showRouteStatus("No se encontraron los controles de origen y destino.");
      return;
    }

    const originId = originSelect.value;
    const destinationId = destinationSelect.value;

    if (!originId || !destinationId) {
      showRouteStatus("Selecciona tanto el origen como el destino.");
      return;
    }

    if (originId === destinationId) {
      showRouteStatus(
        "El origen y el destino deben ser dos ubicaciones diferentes."
      );
      return;
    }

    const origin = findLocationById(originId);
    const destination = findLocationById(destinationId);

    if (
      !origin ||
      !destination ||
      !hasCoordinates(origin) ||
      !hasCoordinates(destination)
    ) {
      showRouteStatus(
        "Una de las ubicaciones no tiene coordenadas válidas. Revisa locations.json."
      );
      return;
    }

    if (!map || !routeLayer) {
      showRouteStatus("El mapa todavía no está disponible.");
      return;
    }

    clearRoute({ showStatus: false });

    routeRequestInProgress = true;

    if (calculateButton) {
      calculateButton.disabled = true;
    }

    showRouteStatus("Calculando ruta por calles…");

    try {
      // OSRM requiere longitud,latitud, no latitud,longitud.
      const coordinates = [
        `${origin.longitude},${origin.latitude}`,
        `${destination.longitude},${destination.latitude}`
      ].join(";");

      const url =
        `${CONFIG.osrmUrl}/${coordinates}` +
        "?overview=full&geometries=geojson&steps=false";

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`El servicio de rutas respondió HTTP ${response.status}.`);
      }

      const data = await response.json();

      if (
        data.code !== "Ok" ||
        !Array.isArray(data.routes) ||
        !data.routes.length ||
        !data.routes[0].geometry
      ) {
        throw new Error(
          "No se encontró una ruta entre esos puntos. Puede faltar cobertura vial o ser necesario revisar las coordenadas."
        );
      }

      const route = data.routes[0];

      const geoJsonFeature = {
        type: "Feature",
        properties: {},
        geometry: route.geometry
      };

      const routeLine = L.geoJSON(geoJsonFeature, {
        style: {
          color: CONFIG.routeColor,
          weight: 5,
          opacity: 0.9
        }
      });

      routeLine.addTo(routeLayer);

      // Marcar claramente los puntos elegidos.
      const originPoint = L.circleMarker(
        [origin.latitude, origin.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#238443",
          fillOpacity: 1
        }
      );

      originPoint.bindPopup(
        `<strong>Origen:</strong> ${escapeHtml(origin.name)}`
      );

      const destinationPoint = L.circleMarker(
        [destination.latitude, destination.longitude],
        {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2459a6",
          fillOpacity: 1
        }
      );

      destinationPoint.bindPopup(
        `<strong>Destino:</strong> ${escapeHtml(destination.name)}`
      );

      originPoint.addTo(routeLayer);
      destinationPoint.addTo(routeLayer);

      const routeBounds = routeLine.getBounds();

      if (routeBounds.isValid()) {
        map.fitBounds(routeBounds, {
          padding: [35, 35],
          maxZoom: 15
        });
      }

      currentRoute = {
        originId: origin.id,
        destinationId: destination.id,
        distance: route.distance,
        duration: route.duration
      };

      renderRouteSummary(origin, destination, route);

      showRouteStatus("Ruta calculada correctamente.");
    } catch (error) {
      console.error("Error al calcular la ruta:", error);

      showRouteStatus(
        `No se pudo calcular la ruta. ${error.message || "Revisa tu conexión e inténtalo de nuevo."}`
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
    const originSelect = getElement("routeOrigin");
    const destinationSelect = getElement("routeDestination");

    if (calculateButton) {
      calculateButton.addEventListener("click", calculateRoute);
    }

    if (clearButton) {
      clearButton.addEventListener("click", function () {
        clearRoute();
      });
    }

    [originSelect, destinationSelect].forEach(select => {
      if (select) {
        select.addEventListener("change", function () {
          if (currentRoute) {
            clearRoute({
              showStatus: false
            });

            showRouteStatus(
              "Cambiaste uno de los puntos. Pulsa «Calcular ruta» para obtener el nuevo recorrido."
            );
          }
        });
      }
    });
  }

  // ------------------------------------------------------------
  // CARGA DE UBICACIONES
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
          "El archivo locations.json no contiene un arreglo locations válido."
        );
      }

      allLocations = data.locations.filter(location =>
        location &&
        typeof location === "object" &&
        typeof location.name === "string"
      );

      // Leer los parámetros de la URL una sola vez.
      const params = new URLSearchParams(window.location.search);
      const requestedCity = params.get("city");
      const requestedLocation = params.get("location");

      // Aplicar el filtro de ciudad, si se proporcionó.
      if (requestedCity) {
        const matchingCity = allLocations.find(location =>
          String(location.city || "").toLocaleLowerCase("es") ===
          requestedCity.toLocaleLowerCase("es")
        );

        state.city = matchingCity ? matchingCity.city : "all";
      } else {
        state.city = "all";
      }

      renderCityOptions();
      renderMarkers();
      populateRouteSelectors();

      // Abrir el marcador solicitado desde el itinerario.
      if (requestedLocation) {
        const found = showLocation(requestedLocation);

        if (!found) {
          showStatus(
            "No se encontró un marcador para este lugar. " +
            "Verifica el locationId y las coordenadas en locations.json."
          );
        }
      }

      if (allLocations.length === 0) {
        showStatus("No se encontraron ubicaciones en el archivo.");
      } else if (
        !allLocations.some(location => hasCoordinates(location))
      ) {
        showStatus(
          "Se cargaron las ubicaciones, pero ninguna tiene coordenadas válidas."
        );
      }
    } catch (error) {
      console.error("Error al cargar las ubicaciones:", error);

      showStatus(
        "No se pudieron cargar las ubicaciones. " +
        "Verifica la ruta y el formato de locations.json."
      );

      showRouteStatus(
        "No se pueden calcular rutas porque no se cargaron las ubicaciones."
      );
    }
  }

  function start() {
    if (!initializeMap()) {
      return;
    }

    connectFilters();
    connectRouteControls();
    loadLocations();
  }

  // API pública para integraciones con otras páginas.
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
