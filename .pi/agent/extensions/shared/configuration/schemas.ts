import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { reviewerSchema } from "../review/protocol.ts";
import { credentialProfileSchema } from "./credential-profile.ts";

const reviewContextProperties = {
  recentUserPrompts: Type.Integer({ minimum: 1, maximum: 20 }),
  // A transport watchdog, NOT the intended duration of an ordinary review.
  requestTimeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
};
export const configSchema = Type.Object(
  {
    ...reviewContextProperties,
    sandbox: Type.Union([
      Type.Object({ backend: Type.Literal("bwrap") }, { additionalProperties: false }),
      Type.Object(
        {
          backend: Type.Literal("docker"),
          image: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export type PortableConfig = Static<typeof configSchema>;

const absolutePath = Type.String({ pattern: "^/", minLength: 1 });
export const localConfigSchema = Type.Object(
  {
    credentialProfiles: Type.Optional(Type.Array(credentialProfileSchema, { maxItems: 32 })),
    sandbox: Type.Optional(
      Type.Object(
        {
          executable: Type.Optional(absolutePath),
          runnerExecutable: Type.Optional(absolutePath),
          cgroupRoot: Type.Optional(absolutePath),
          dockerExecutable: Type.Optional(absolutePath),
          workspaceViews: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  root: absolutePath,
                  paths: Type.Array(absolutePath, { minItems: 1, maxItems: 200 }),
                },
                { additionalProperties: false },
              ),
              { maxItems: 20 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type LocalConfig = Static<typeof localConfigSchema>;

export const resolvedConfigSchema = Type.Object(
  {
    ...reviewContextProperties,
    // An unconfigured installation can start, but no action can pass independent review.
    reviewer: Type.Optional(reviewerSchema),
    credentialProfiles: Type.Optional(Type.Array(credentialProfileSchema, { maxItems: 32 })),
    sandbox: Type.Union([
      Type.Object(
        {
          backend: Type.Optional(Type.Literal("docker")),
          dockerExecutable: Type.String({ pattern: "^/", minLength: 1 }),
          image: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
          workspaceRoots: Type.Optional(
            Type.Array(Type.String({ pattern: "^/", minLength: 1 }), { maxItems: 20 }),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          backend: Type.Literal("bwrap"),
          executable: Type.String({ pattern: "^/", minLength: 1 }),
          runnerExecutable: Type.String({ pattern: "^/", minLength: 1 }),
          cgroupRoot: Type.Optional(absolutePath),
          workspaceRoots: Type.Optional(
            Type.Array(Type.String({ pattern: "^/", minLength: 1 }), { maxItems: 20 }),
          ),
          workspaceViews: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  root: Type.String({ pattern: "^/", minLength: 1 }),
                  paths: Type.Array(Type.String({ pattern: "^/", minLength: 1 }), {
                    minItems: 1,
                    maxItems: 200,
                  }),
                },
                { additionalProperties: false },
              ),
              { maxItems: 20 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof resolvedConfigSchema>;

export function parseConfig(text: string): PortableConfig {
  const value: unknown = JSON.parse(text);

  if (!Check(configSchema, value)) throw new Error("Invalid auto-approval.json configuration");

  return value;
}

export function parseLocalConfig(text: string): LocalConfig {
  const value: unknown = JSON.parse(text);

  if (!Check(localConfigSchema, value))
    throw new Error("Invalid auto-approval.device.json configuration");

  return value;
}
