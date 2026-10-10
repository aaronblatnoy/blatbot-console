// Copy to static/config.js and point it at the console API. static/config.js is not
// tracked: it holds where one particular deployment's API is. The container entrypoint
// writes it from CONSOLE_API_BASE and CONSOLE_EVENTS_URL.
window.CONSOLE_CONFIG = {
  apiBase: "http://127.0.0.1:8792/console/api",
  eventsUrl: "http://127.0.0.1:8792/console/events",
};
