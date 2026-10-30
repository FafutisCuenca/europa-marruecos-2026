
(() => {
  "use strict";

  const API = "https://ljcuenca.goatcounter.com/api/v0";
  const SESSION_KEY = "europaMarruecosGoatCounterToken";

  const countryCount = document.getElementById("countryCount");
  const topCountry = document.getElementById("topCountry");
  const regionCount = document.getElementById("regionCount");

  const geoStatus = document.getElementById("geoStatus");
  const visitorsMap = document.getElementById("visitorsMap");

  const countryTable = document.getElementById("countryTable");
  const regionTable = document.getElementById("regionTable");

  const refreshButton = document.getElementById("refreshGeo");

  function numberFormat(value) {
    return Number(value || 0).toLocaleString("es-MX");
  }

  function getSessionKey() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  }

  async function apiGet(path, key) {
    const response = await fetch(API + path, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + key,
        "Accept": "application/json"
      },
      cache: "no-store"
    });

    const responseText = await response.text();

    if (!response.ok) {
      const error = new Error(
        "HTTP " + response.status + ": " +
        responseText.slice(0, 250)
      );

      error.status = response.status;
      throw error;
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error("La API no devolvió JSON válido.");
    }
  }

  function createCell(value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    return cell;
  }

  function showEmptyRow(element, columns, message) {
    element.replaceChildren();

    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = columns;
    cell.textContent = message;

    row.appendChild(cell);
    element.appendChild(row);
  }

  function renderCountries(countries) {
    countryTable.replaceChildren();

    if (!countries.length) {
      showEmptyRow(
        countryTable,
        2,
        "GoatCounter todavía no proporciona países identificados."
      );
      return;
    }

    countries.forEach(country => {
      const row = document.createElement("tr");

      row.append(
        createCell(country.name),
        createCell(numberFormat(country.count))
      );

      countryTable.appendChild(row);
    });
  }

  function renderRegions(regions, countriesByCode) {
    regionTable.replaceChildren();

    if (!regions.length) {
      showEmptyRow(
        regionTable,
        3,
        "No hay regiones identificadas disponibles."
      );
      return;
    }

    regions.forEach(region => {
      const row = document.createElement("tr");

      const countryCode = region.id.split("-")[0];

      const country = countriesByCode.get(countryCode);

      row.append(
        createCell(region.name),
        createCell(country ? country.name : countryCode),
        createCell(numberFormat(region.count))
      );

      regionTable.appendChild(row);
    });
  }

  function renderDistribution(countries) {
    visitorsMap.replaceChildren();

    if (!countries.length) {
      visitorsMap.textContent =
        "No hay información geográfica suficiente para mostrar.";
      return;
    }

    const maxCount = Math.max(
      1,
      ...countries.map(item => item.count)
    );

    countries.slice(0, 15).forEach(country => {
      const item = document.createElement("div");
      item.className = "geo-item";

      const heading = document.createElement("div");
      heading.className = "geo-heading";

      const name = document.createElement("span");
      name.textContent = country.name;

      const count = document.createElement("span");
      count.textContent = numberFormat(country.count);

      heading.append(name, count);

      const track = document.createElement("div");
      track.className = "geo-track";

      const fill = document.createElement("div");
      fill.className = "geo-fill";

      fill.style.width =
        Math.min(100, (country.count / maxCount) * 100) + "%";

      track.appendChild(fill);

      const code = document.createElement("div");
      code.className = "geo-code";
      code.textContent = "Código: " + country.id;

      item.append(heading, track, code);

      visitorsMap.appendChild(item);
    });
  }

  function normalizeLocations(data) {
    const source = Array.isArray(data.stats)
      ? data.stats
      : Array.isArray(data.locations)
        ? data.locations
        : [];

    return source
      .filter(item => item && item.id && item.name)
      .map(item => ({
        id: String(item.id),
        name: String(item.name),
        count: Number(item.count) || 0
      }))
      .filter(item => item.count >= 0);
  }

  function renderData(locations) {
    // Los códigos sin guion representan países.
    const countries = locations
      .filter(item => !item.id.includes("-"))
      .sort((a, b) => b.count - a.count);

    // Los códigos con guion representan subdivisiones regionales.
    const regions = locations
      .filter(item => item.id.includes("-"))
      .sort((a, b) => b.count - a.count);

    const countriesByCode = new Map(
      countries.map(country => [country.id.split("-")[0], country])
    );

    countryCount.textContent = numberFormat(countries.length);

    regionCount.textContent = numberFormat(regions.length);

    topCountry.textContent = countries.length
      ? countries[0].name
      : "Sin datos";

    renderCountries(countries);
    renderRegions(regions, countriesByCode);
    renderDistribution(countries);

    return {
      countries,
      regions
    };
  }

  async function loadGeography() {
    const key = getSessionKey();

    if (!key) {
      geoStatus.textContent =
        "No hay una sesión activa. Ve al Resumen general e introduce tu clave API.";

      countryCount.textContent = "—";
      topCountry.textContent = "—";
      regionCount.textContent = "—";

      visitorsMap.textContent = "Se requiere una sesión activa.";

      showEmptyRow(
        countryTable,
        2,
        "No hay una sesión activa."
      );

      showEmptyRow(
        regionTable,
        3,
        "No hay una sesión activa."
      );

      return;
    }

    refreshButton.disabled = true;

    geoStatus.textContent =
      "Consultando procedencia geográfica en GoatCounter...";

    try {
      const data = await apiGet("/stats/locations", key);

      const locations = normalizeLocations(data);

      const result = renderData(locations);

      if (!result.countries.length && !result.regions.length) {
        geoStatus.textContent =
          "La conexión es correcta, pero GoatCounter todavía no proporciona datos geográficos.";
      } else {
        geoStatus.textContent =
          "Información geográfica actualizada correctamente. " +
          "Países: " + result.countries.length +
          " · Regiones: " + result.regions.length + ".";
      }

    } catch (error) {
      console.error(
        "Error al consultar procedencia geográfica:",
        error
      );

      if (error.status === 401 || error.status === 403) {
        sessionStorage.removeItem(SESSION_KEY);

        geoStatus.textContent =
          "La sesión ya no es válida. Regresa al Resumen general y conecta nuevamente.";

      } else if (error.status === 429) {
        geoStatus.textContent =
          "Se alcanzó el límite de consultas. Espera unos segundos y vuelve a intentarlo.";

      } else {
        geoStatus.textContent =
          "No fue posible consultar la información geográfica: " +
          error.message;
      }

    } finally {
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener("click", loadGeography);

  loadGeography();

})();
