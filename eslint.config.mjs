// ESLint flat config — enforces CLAUDE.md -> "Tech stack (locked)", "Folder structure and layering",
// "Module file conventions" (item 11) and "Code style — what to avoid".
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Libraries forbidden by CLAUDE.md -> Tech stack (locked). */
const FORBIDDEN_MESSAGE = "Forbidden by CLAUDE.md → Tech stack (locked)";

const FORBIDDEN_PATHS = [
  "prisma",
  "typeorm",
  "sequelize",
  "sequelize-typescript",
  "drizzle-orm",
  "kysely",
  "graphql",
  "grpc",
  "passport",
  "auth0",
  "jsonwebtoken",
  "moment",
  "moment-timezone",
  "cors",
  "uuid",
  "dotenv",
  "axios",
  "node-fetch",
].map((name) => ({ name, message: FORBIDDEN_MESSAGE }));

const FORBIDDEN_PATTERNS = [
  {
    group: [
      "@prisma/*",
      "drizzle-orm/*",
      "@mikro-orm/*",
      "@nestjs/*",
      "@apollo/*",
      "apollo-server*",
      "@grpc/*",
      "@trpc/*",
      "passport-*",
      "@auth0/*",
      "@clerk/*",
    ],
    message: FORBIDDEN_MESSAGE,
  },
];

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/"],
  },

  // Config files: no type-aware linting, console allowed.
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { sourceType: "module" },
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        require: "readonly",
        process: "readonly",
        __dirname: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },

  // All TypeScript.
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        { paths: FORBIDDEN_PATHS, patterns: FORBIDDEN_PATTERNS },
      ],
    },
  },

  // CLAUDE.md -> Module file conventions (item 11): types live in the folder's types.ts.
  {
    files: ["src/**/*.ts"],
    ignores: ["**/types.ts", "**/*.d.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSInterfaceDeclaration",
          message: "Declare types in the folder's types.ts (CLAUDE.md → Module file conventions)",
        },
        {
          selector: "TSTypeAliasDeclaration",
          message: "Declare types in the folder's types.ts (CLAUDE.md → Module file conventions)",
        },
      ],
    },
  },

  // Layering: pkg/ is pure.
  {
    files: ["src/pkg/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...FORBIDDEN_PATHS,
            ...["express", "knex", "pg", "ioredis", "tsyringe", "zod"].map((name) => ({
              name,
              message: "pkg/ is pure (CLAUDE.md → Folder structure and layering)",
            })),
          ],
          patterns: [
            ...FORBIDDEN_PATTERNS,
            {
              group: ["**/lib/**", "**/app/**"],
              message: "pkg/ is pure (CLAUDE.md → Folder structure and layering)",
            },
          ],
        },
      ],
    },
  },

  // Layering: lib/ must not import app/.
  {
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FORBIDDEN_PATHS,
          patterns: [
            ...FORBIDDEN_PATTERNS,
            { group: ["**/app/**"], message: "lib/ must not import app/" },
          ],
        },
      ],
    },
  },

  // Layering: cross-module calls go through services, never another module's repository.
  {
    files: ["src/app/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FORBIDDEN_PATHS,
          patterns: [
            ...FORBIDDEN_PATTERNS,
            {
              group: ["../../*/repository/*", "**/app/*/repository/*"],
              message: "cross-module calls go through services (CLAUDE.md → Folder structure and layering)",
            },
          ],
        },
      ],
    },
  },

  // The public app never imports internal routers or controllers.
  {
    files: ["src/app.ts", "src/routes.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...FORBIDDEN_PATHS,
            { name: "./internal-routes", message: "public app never imports internal routers or controllers" },
            { name: "./internal-app", message: "public app never imports internal routers or controllers" },
          ],
          patterns: [
            ...FORBIDDEN_PATTERNS,
            {
              group: ["**/internal-*/**"],
              message: "public app never imports internal routers or controllers",
            },
          ],
        },
      ],
    },
  },
);
