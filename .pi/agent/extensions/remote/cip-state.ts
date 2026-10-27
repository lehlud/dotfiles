import type { RemoteTarget } from "../shared/contracts/remote.ts";
import type { CipMachine, CipRequirements } from "./cip-inventory.ts";
import { validateTarget } from "./target.ts";

export type CipHealth = {
  home: string;
  tmp: string;
  occupants: string[];
  quotaText: string;
  quota: { usedMiB: number; limitMiB: number; percent: number; path: string }[];
};

export type CipNode = {
  id: string;
  target: RemoteTarget;
  machine: CipMachine;
  requirements: CipRequirements;
  health: CipHealth;
  unavailable?: string;
};

export type CipState = {
  kind: "cip";
  user: string;
  folder: string;
  nodes: CipNode[];
  anchor?: RemoteTarget;
  pending?: { requirements: CipRequirements; reason: string }[];
};

export function cipHealth(value: any): CipHealth {
  if (
    !value ||
    !value.home?.startsWith("/") ||
    value.tmp !== "/proj/ciptmp" ||
    !Array.isArray(value.occupants) ||
    value.occupants.some((user: any) => typeof user !== "string") ||
    typeof value.quotaText !== "string" ||
    value.quotaText.length > 65536 ||
    !Array.isArray(value.quota)
  )
    throw new Error("Invalid CIP occupancy/shared-mount/quota evidence");

  return {
    home: value.home,
    tmp: value.tmp,
    occupants: value.occupants,
    quotaText: value.quotaText,
    quota: value.quota,
  };
}

export function restoreCipState(value: any): CipState {
  if (
    value?.kind !== "cip" ||
    !Array.isArray(value.nodes) ||
    (!value.nodes.length && !value.anchor) ||
    value.nodes.length > 4
  )
    throw new Error("Invalid saved CIP pool");

  const nodes = value.nodes.map((node: CipNode) => {
    const target = validateTarget(node.target);

    if (
      !target.cip ||
      target.cip.node !== node.id ||
      target.user !== value.user ||
      target.folder !== value.folder ||
      node.machine?.host !== target.host ||
      !node.requirements ||
      typeof node.requirements !== "object"
    )
      throw new Error("Invalid saved CIP node");

    return { ...node, target, health: cipHealth(node.health) };
  });

  if (
    new Set(nodes.map((node: CipNode) => node.id)).size !== nodes.length ||
    new Set(nodes.map((node: CipNode) => node.target.host)).size !== nodes.length
  )
    throw new Error("Duplicate CIP slot or workstation");

  const anchor = validateTarget(value.anchor ?? nodes[0].target);

  if (
    !anchor.cip ||
    anchor.user !== value.user ||
    anchor.folder !== value.folder ||
    !Array.isArray(value.pending ?? [])
  )
    throw new Error("Invalid CIP workspace anchor");

  return {
    kind: "cip",
    user: value.user,
    folder: value.folder,
    nodes,
    anchor,
    pending: (value.pending ?? []).slice(-4),
  };
}
