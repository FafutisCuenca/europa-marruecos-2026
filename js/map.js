
/*
 * Europa + Marruecos 2026
 * Archivo: js/map.js
 * Función: inicializar el mapa y mostrar las ubicaciones del viaje.
 *
 * Dependencia: Leaflet debe cargarse previamente en mapa.html.
 */

(function () {
  "use strict";

  const CONFIG = {
    locationsUrl: "./data/locations.json",
    defaultCenter: [40.4168, -3.7038],
    defaultZoom: 5
  };

  let map = null;
  let markerLayer = null;
  let allLocations = [];
  let markersById = new Map();

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

      if (location.id) {
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
          data-location-id="${escapeHtml(location.id || "")}"
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
    if (!id) {
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
    }
  }

  function start() {
    if (!initializeMap()) {
      return;
    }

    connectFilters();
    loadLocations();
  }

  window.TripMap = {
    start,
    refresh: loadLocations,

    filterByCity: function (city) {
      state.city = city || "all";

      const select = getElement("mapCityFilter");

      if (select) {
        select.value = state.city;
      }

      renderMarkers();
    },

    showLocation
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
