
(() => {
  "use strict";

  const API = "https://ljcuenca.goatcounter.com/api/v0";
  const SESSION_KEY = "europaMarruecosGoatCounterToken";

  const status = document.getElementById("historyStatus");
  const visitsChart = document.getElementById("visitsChart");
  const visitsDetail = document.getElementById("visitsDetail");
  const periodVisits = document.getElementById("periodVisits");
  const periodPages = document.getElementById("periodPages");
  const chartDescription = document.getElementById("chartDescription");
  const refreshButton = document.getElementById("refreshHistory");
  const periodButtons = document.querySelectorAll("[data-period]");

  let currentPeriod = "day";
  let dailyData = [];
  let activeHits = [];

  function formatNumber(value) {
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

    const text = await response.text();

    if (!response.ok) {
      const error = new Error(
        "HTTP " + response.status + ": " + text.slice(0, 250)
      );

      error.status = response.status;
      throw error;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("La API no devolvió JSON válido.");
    }
  }

  function getDateRange() {
    const end = new Date();
    const start = new Date();

    start.setDate(start.getDate() - 29);

    // GoatCounter requiere fechas redondeadas a la hora.
    start.setMinutes(0, 0, 0);
    end.setMinutes(0, 0, 0);

    return {
      start: start.toISOString(),
      end: end.toISOString()
    };
  }

  function formatDate(dateString) {
    const date = new Date(dateString + "T12:00:00");

    return date.toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "short"
    });
  }

  function getWeekLabel(dateString) {
    const date = new Date(dateString + "T12:00:00");
    const day = date.getDay();
    const monday = new Date(date);

    monday.setDate(date.getDate() - ((day + 6) % 7));

    return monday.toISOString().slice(0, 10);
  }

  function getMonthLabel(dateString) {
    return dateString.slice(0, 7);
  }

  function formatPeriodLabel(key, period) {
    if (period === "day") {
      return formatDate(key);
    }

    if (period === "week") {
      return "Semana del " + formatDate(key);
    }

    const [year, month] = key.split("-");

    return new Date(
      Number(year),
      Number(month) - 1,
      1
    ).toLocaleDateString("es-MX", {
      month: "long",
      year: "numeric"
    });
  }

  function groupData(period) {
    const groups = new Map();

    dailyData.forEach(item => {
      let key = item.day;

      if (period === "week") {
        key = getWeekLabel(item.day);
      } else if (period === "month") {
        key = getMonthLabel(item.day);
      }

      groups.set(
        key,
        (groups.get(key) || 0) + item.daily
      );
    });

    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        value,
        label: formatPeriodLabel(key, period)
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  function renderChart(data) {
    visitsChart.replaceChildren();

    if (!data.length) {
      visitsChart.textContent =
        "No hay estadísticas disponibles para este periodo.";
      return;
    }

    const maxValue = Math.max(
      1,
      ...data.map(item => item.value)
    );

    data.forEach(item => {
      const column = document.createElement("div");
      column.className = "chart-column";

      const value = document.createElement("span");
      value.className = "chart-value";
      value.textContent = formatNumber(item.value);

      const bar = document.createElement("div");
      bar.className = "chart-bar";

      bar.style.height =
        Math.max(3, (item.value / maxValue) * 150) + "px";

      bar.title = item.label + ": " + formatNumber(item.value);

      const label = document.createElement("span");
      label.className = "chart-label";
      label.textContent =
        item.key.slice(5);

      column.append(value, bar, label);
      visitsChart.appendChild(column);
    });
  }

  function renderTable(data) {
    visitsDetail.replaceChildren();

    if (!data.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 2;
      cell.textContent = "No hay datos para mostrar.";

      row.appendChild(cell);
      visitsDetail.appendChild(row);
      return;
    }

    [...data].reverse().forEach(item => {
      const row = document.createElement("tr");

      const dateCell = document.createElement("td");
      dateCell.textContent = item.label;

      const countCell = document.createElement("td");
      countCell.textContent = formatNumber(item.value);

      row.append(dateCell, countCell);
      visitsDetail.appendChild(row);
    });
  }

  function renderPeriod() {
    const data = groupData(currentPeriod);

    const total = data.reduce(
      (sum, item) => sum + item.value,
      0
    );

    periodVisits.textContent = formatNumber(total);
    periodPages.textContent = formatNumber(activeHits.length);

    chartDescription.textContent =
      currentPeriod === "day"
        ? "Visitantes registrados por día."
        : currentPeriod === "week"
          ? "Visitantes agrupados por semana."
          : "Visitantes agrupados por mes.";

    renderChart(data);
    renderTable(data);
  }

  async function loadHistory() {
    const key = getSessionKey();

    if (!key) {
      status.textContent =
        "No hay una sesión activa. Ve al Resumen general e introduce tu clave API.";
      visitsChart.textContent = "Se requiere una sesión activa.";
      return;
    }

    refreshButton.disabled = true;
    status.textContent = "Consultando estadísticas de GoatCounter...";

    try {
      const range = getDateRange();

      const params = new URLSearchParams({
        start: range.start,
        end: range.end
      });

      const totalData = await apiGet(
        "/stats/total?" + params.toString(),
        key
      );

      const hitsData = await apiGet(
        "/stats/hits?" + params.toString() + "&limit=100",
        key
      );

      dailyData = Array.isArray(totalData.stats)
        ? totalData.stats
            .filter(item => item.day)
            .map(item => ({
              day: item.day,
              daily: Number(item.daily) || 0
            }))
        : [];

      activeHits = Array.isArray(hitsData.hits)
        ? hitsData.hits
        : [];

      renderPeriod();

      status.textContent =
        "Estadísticas actualizadas. Periodo consultado: últimos 30 días.";

    } catch (error) {
      console.error("Error al consultar el histórico:", error);

      if (error.status === 401 || error.status === 403) {
        sessionStorage.removeItem(SESSION_KEY);
        status.textContent =
          "La sesión ya no es válida. Regresa al Resumen general y conecta nuevamente.";
      } else if (error.status === 429) {
        status.textContent =
          "Se alcanzó el límite de consultas. Espera unos segundos y vuelve a intentarlo.";
      } else {
        status.textContent =
          "No fue posible cargar el histórico: " + error.message;
      }

    } finally {
      refreshButton.disabled = false;
    }
  }

  periodButtons.forEach(button => {
    button.addEventListener("click", () => {
      currentPeriod = button.dataset.period;

      periodButtons.forEach(item => {
        item.classList.toggle("active", item === button);
      });

      if (dailyData.length) {
        renderPeriod();
      }
    });
  });

  refreshButton.addEventListener("click", loadHistory);

  loadHistory();

})();
