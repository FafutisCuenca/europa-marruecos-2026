
(() => {
  "use strict";

  // Identificar la página administrativa actual.
  const currentPage = window.location.pathname
    .split("/")
    .pop() || "index.html";

  // Actualizar automáticamente la opción activa del menú.
  const navigationLinks = document.querySelectorAll(
    ".navigation a"
  );

  navigationLinks.forEach((link) => {
    const linkPage = link.getAttribute("href")
      .split("/")
      .pop();

    const isCurrentPage = linkPage === currentPage;

    link.classList.toggle("active", isCurrentPage);

    if (isCurrentPage) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

})();
