// Keep native module loading outside Vite/RSC's rewritten import graph. The
// caller supplies only a server-owned file URL with a fixed carrier revision.
module.exports = function loadDshCarrier(location) {
  return import(location);
};
