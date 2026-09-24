import { cached } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const DEFAULT_MEMBERS_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const DEFAULT_MEMBER_DETAIL_TTL_MS = 60 * 60 * 1000; // 1h

function extractMembersFromPyrusData(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.members)) return data.members;
  if (data.employeesByLine && typeof data.employeesByLine === "object") {
    const aggregated = [];
    for (const value of Object.values(data.employeesByLine)) {
      if (Array.isArray(value)) aggregated.push(...value);
    }
    return aggregated;
  }
  return [];
}

function buildMembersIndex(members) {
  const membersById = new Map();
  const membersByEmail = new Map();

  for (const member of members) {
    if (!member) continue;
    if (member.id != null) membersById.set(member.id, member);
    const email = String(member.email || "").trim();
    if (email) membersByEmail.set(email.toLowerCase(), member);
  }

  return { members, membersById, membersByEmail };
}

export function createMembersService({ pyrusClient, ttlMs = DEFAULT_MEMBERS_TTL_MS } = {}) {
  if (!pyrusClient || typeof pyrusClient.pyrusRequest !== "function") {
    throw new Error("pyrusClient is required for membersService");
  }

  async function getMembers({ force } = {}) {
    return cached(
      "pyrus:members",
      { ttlMs, force },
      async () => {
        const raw = await pyrusClient.pyrusRequest("/v4/members", { method: "GET" });
        return unwrapPyrusData(raw);
      }
    );
  }

  async function getMembersIndex({ force } = {}) {
    return cached(
      "pyrus:members:index",
      { ttlMs, force },
      async () => {
        const data = await getMembers({ force });
        const members = extractMembersFromPyrusData(data);
        return buildMembersIndex(members);
      }
    );
  }

  async function getMemberDetails({ id, force } = {}) {
    if (!id) {
      throw new Error("id is required for getMemberDetails");
    }
    return cached(
      `pyrus:members:detail:${id}`,
      { ttlMs: DEFAULT_MEMBER_DETAIL_TTL_MS, force },
      async () => {
        const raw = await pyrusClient.pyrusRequest(`/v4/members/${id}`, { method: "GET" });
        return unwrapPyrusData(raw);
      }
    );
  }

  return { getMembers, getMembersIndex, getMemberDetails, extractMembersFromPyrusData };
}
