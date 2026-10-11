import { Type, type Static } from "typebox";

export const credentialNameSchema = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
export const environmentNameSchema = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" });
export const credentialValueSchema = Type.String({ maxLength: 16384, pattern: "^[^\\u0000]*$" });
const profileProperties = {
  name: credentialNameSchema,
  executable: Type.String({ pattern: "^/", maxLength: 4096 }),
  environment: Type.Optional(
    Type.Record(environmentNameSchema, credentialValueSchema, { maxProperties: 32 }),
  ),
  secrets: Type.Record(
    environmentNameSchema,
    Type.Union([
      Type.Object(
        { type: Type.Literal("environment"), name: environmentNameSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { type: Type.Literal("file"), path: Type.String({ pattern: "^/", maxLength: 4096 }) },
        { additionalProperties: false },
      ),
    ]),
    { minProperties: 1, maxProperties: 16 },
  ),
};
export const credentialProfileSchema = Type.Union([
  Type.Object(
    { ...profileProperties, argumentPolicy: Type.Literal("review") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...profileProperties,
      allowedArgv: Type.Array(
        Type.Array(
          Type.Union([
            Type.Object({ literal: credentialValueSchema }, { additionalProperties: false }),
            Type.Object(
              { pattern: Type.String({ minLength: 1, maxLength: 500 }) },
              { additionalProperties: false },
            ),
          ]),
          { minItems: 1, maxItems: 64 },
        ),
        { minItems: 1, maxItems: 64 },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type CredentialProfile = Static<typeof credentialProfileSchema>;
