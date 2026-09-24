import { cached } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const DEFAULT_CATALOG_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export function createCatalogsService({ pyrusClient, ttlMs = DEFAULT_CATALOG_TTL_MS } = {}) {
  if (!pyrusClient || typeof pyrusClient.pyrusRequest !== "function") {
    throw new Error("pyrusClient is required for catalogsService");
  }

  async function getShiftsCatalog({ catalogId, force } = {}) {
    if (!catalogId) {
      throw new Error("catalogId is required for getShiftsCatalog");
    }
    return cached(
      `pyrus:catalogs:shifts:${catalogId}`,
      { ttlMs, force },
      async () => {
        const raw = await pyrusClient.pyrusRequest(`/v4/catalogs/${catalogId}`, {
          method: "GET",
        });
        return unwrapPyrusData(raw);
      }
    );
  }

  return { getShiftsCatalog };
}
