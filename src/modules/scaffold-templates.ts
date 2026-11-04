import type { ScaffoldTemplates, TemplateFile } from "./scaffold";
import bunAppV1BiomeJson from "./templates/_bun/app/v1/biome.json.tmpl" with {
  type: "text",
};
import bunAppV1SrcPreparedTs from "./templates/_bun/app/v1/src/prepared.ts.tmpl" with {
  type: "text",
};
import bunAppV1TestsStartTestTs from "./templates/_bun/app/v1/tests/start.test.ts.tmpl" with {
  type: "text",
};
import bunDotGithubWorkflowsCheckYml from "./templates/_bun/dot-github/workflows/check.yml.tmpl" with {
  type: "text",
};
import commonAgentsMd from "./templates/_common/AGENTS.md.tmpl" with {
  type: "text",
};
import commonDotGitignore from "./templates/_common/dot-gitignore.tmpl" with {
  type: "text",
};
import personalAgentsMd from "./templates/_personal/AGENTS.md.tmpl" with {
  type: "text",
};
import astroAppV1AstroConfigTs from "./templates/astro/app/v1/astro.config.ts.tmpl" with {
  type: "text",
};
import astroAppV1PackageJson from "./templates/astro/app/v1/package.json.tmpl" with {
  type: "text",
};
import astroAppV1SrcGreetingTestTs from "./templates/astro/app/v1/src/greeting.test.ts.tmpl" with {
  type: "text",
};
import astroAppV1SrcGreetingTs from "./templates/astro/app/v1/src/greeting.ts.tmpl" with {
  type: "text",
};
import astroAppV1SrcPagesIndexAstro from "./templates/astro/app/v1/src/pages/index.astro.tmpl" with {
  type: "text",
};
import astroAppV1SrcPreparedTs from "./templates/astro/app/v1/src/prepared.ts.tmpl" with {
  type: "text",
};
import astroAppV1TsconfigJson from "./templates/astro/app/v1/tsconfig.json.tmpl" with {
  type: "text",
};
import astroReadmeMd from "./templates/astro/README.md.tmpl" with {
  type: "text",
};
import astroStarlightAppV1AstroConfigTs from "./templates/astro-starlight/app/v1/astro.config.ts.tmpl" with {
  type: "text",
};
import astroStarlightAppV1PackageJson from "./templates/astro-starlight/app/v1/package.json.tmpl" with {
  type: "text",
};
import astroStarlightAppV1SrcContentDocsIndexMd from "./templates/astro-starlight/app/v1/src/content/docs/index.md.tmpl" with {
  type: "text",
};
import astroStarlightAppV1SrcContentConfigTs from "./templates/astro-starlight/app/v1/src/content.config.ts.tmpl" with {
  type: "text",
};
import astroStarlightAppV1SrcPreparedTs from "./templates/astro-starlight/app/v1/src/prepared.ts.tmpl" with {
  type: "text",
};
import astroStarlightAppV1TestsDocsTestTs from "./templates/astro-starlight/app/v1/tests/docs.test.ts.tmpl" with {
  type: "text",
};
import astroStarlightAppV1TsconfigJson from "./templates/astro-starlight/app/v1/tsconfig.json.tmpl" with {
  type: "text",
};
import astroStarlightReadmeMd from "./templates/astro-starlight/README.md.tmpl" with {
  type: "text",
};
import bunServiceAppV1PackageJson from "./templates/bun-service/app/v1/package.json.tmpl" with {
  type: "text",
};
import bunServiceAppV1SrcAppTestTs from "./templates/bun-service/app/v1/src/app.test.ts.tmpl" with {
  type: "text",
};
import bunServiceAppV1SrcAppTs from "./templates/bun-service/app/v1/src/app.ts.tmpl" with {
  type: "text",
};
import bunServiceAppV1SrcServerTs from "./templates/bun-service/app/v1/src/server.ts.tmpl" with {
  type: "text",
};
import bunServiceAppV1TsconfigJson from "./templates/bun-service/app/v1/tsconfig.json.tmpl" with {
  type: "text",
};
import bunServiceReadmeMd from "./templates/bun-service/README.md.tmpl" with {
  type: "text",
};
import noneReadmeMd from "./templates/none/README.md.tmpl" with {
  type: "text",
};
import pythonUvAppV1PackageJson from "./templates/python-uv/app/v1/package.json.tmpl" with {
  type: "text",
};
import pythonUvAppV1PyprojectToml from "./templates/python-uv/app/v1/pyproject.toml.tmpl" with {
  type: "text",
};
import pythonUvAppV1SrcPackageInitPy from "./templates/python-uv/app/v1/src/{{python_package}}/__init__.py.tmpl" with {
  type: "text",
};
import pythonUvAppV1SrcPackagePyTyped from "./templates/python-uv/app/v1/src/{{python_package}}/py.typed.tmpl" with {
  type: "text",
};
import pythonUvAppV1SrcPackageServerPy from "./templates/python-uv/app/v1/src/{{python_package}}/server.py.tmpl" with {
  type: "text",
};
import pythonUvAppV1TestsTestServerPy from "./templates/python-uv/app/v1/tests/test_server.py.tmpl" with {
  type: "text",
};
import pythonUvDotGithubWorkflowsCheckYml from "./templates/python-uv/dot-github/workflows/check.yml.tmpl" with {
  type: "text",
};
import pythonUvReadmeMd from "./templates/python-uv/README.md.tmpl" with {
  type: "text",
};
import viteReactAppV1IndexHtml from "./templates/vite-react/app/v1/index.html.tmpl" with {
  type: "text",
};
import viteReactAppV1PackageJson from "./templates/vite-react/app/v1/package.json.tmpl" with {
  type: "text",
};
import viteReactAppV1SrcAppTsx from "./templates/vite-react/app/v1/src/App.tsx.tmpl" with {
  type: "text",
};
import viteReactAppV1SrcGreetingTestTs from "./templates/vite-react/app/v1/src/greeting.test.ts.tmpl" with {
  type: "text",
};
import viteReactAppV1SrcGreetingTs from "./templates/vite-react/app/v1/src/greeting.ts.tmpl" with {
  type: "text",
};
import viteReactAppV1SrcMainTsx from "./templates/vite-react/app/v1/src/main.tsx.tmpl" with {
  type: "text",
};
import viteReactAppV1TsconfigJson from "./templates/vite-react/app/v1/tsconfig.json.tmpl" with {
  type: "text",
};
import viteReactAppV1ViteConfigTs from "./templates/vite-react/app/v1/vite.config.ts.tmpl" with {
  type: "text",
};
import viteReactReadmeMd from "./templates/vite-react/README.md.tmpl" with {
  type: "text",
};

// The templates of a new module (decision F52), embedded in the compiled
// executable as text: every file of `src/modules/templates/<layer>/`, by its
// path in the layer. Each file ends in `.tmpl`, so none of them is an input of
// this repository's own TypeScript, Biome or tests; `templateTargetPath`
// drops the suffix. Provenance and the layers: `src/modules/templates/README.md`.
// A test keeps this list equal to the directory.

// A checkout with CRLF line endings must not change a module's tree hash.
const lf = (text: string) => text.replace(/\r\n/g, "\n");

const layer = (
  files: Readonly<Record<string, string>>,
): readonly TemplateFile[] =>
  Object.freeze(
    Object.entries(files).map(([path, content]) =>
      Object.freeze({ path, content: lf(content) }),
    ),
  );

export const moduleTemplates: ScaffoldTemplates = Object.freeze({
  layers: Object.freeze({
    _common: layer({
      "AGENTS.md.tmpl": commonAgentsMd,
      "dot-gitignore.tmpl": commonDotGitignore,
    }),
    _bun: layer({
      "app/v1/biome.json.tmpl": bunAppV1BiomeJson,
      "app/v1/src/prepared.ts.tmpl": bunAppV1SrcPreparedTs,
      "app/v1/tests/start.test.ts.tmpl": bunAppV1TestsStartTestTs,
      "dot-github/workflows/check.yml.tmpl": bunDotGithubWorkflowsCheckYml,
    }),
    _personal: layer({
      "AGENTS.md.tmpl": personalAgentsMd,
    }),
    "vite-react": layer({
      "README.md.tmpl": viteReactReadmeMd,
      "app/v1/index.html.tmpl": viteReactAppV1IndexHtml,
      "app/v1/package.json.tmpl": viteReactAppV1PackageJson,
      "app/v1/src/App.tsx.tmpl": viteReactAppV1SrcAppTsx,
      "app/v1/src/greeting.test.ts.tmpl": viteReactAppV1SrcGreetingTestTs,
      "app/v1/src/greeting.ts.tmpl": viteReactAppV1SrcGreetingTs,
      "app/v1/src/main.tsx.tmpl": viteReactAppV1SrcMainTsx,
      "app/v1/tsconfig.json.tmpl": viteReactAppV1TsconfigJson,
      "app/v1/vite.config.ts.tmpl": viteReactAppV1ViteConfigTs,
    }),
    astro: layer({
      "README.md.tmpl": astroReadmeMd,
      "app/v1/astro.config.ts.tmpl": astroAppV1AstroConfigTs,
      "app/v1/package.json.tmpl": astroAppV1PackageJson,
      "app/v1/src/greeting.test.ts.tmpl": astroAppV1SrcGreetingTestTs,
      "app/v1/src/greeting.ts.tmpl": astroAppV1SrcGreetingTs,
      "app/v1/src/pages/index.astro.tmpl": astroAppV1SrcPagesIndexAstro,
      "app/v1/src/prepared.ts.tmpl": astroAppV1SrcPreparedTs,
      "app/v1/tsconfig.json.tmpl": astroAppV1TsconfigJson,
    }),
    "astro-starlight": layer({
      "README.md.tmpl": astroStarlightReadmeMd,
      "app/v1/astro.config.ts.tmpl": astroStarlightAppV1AstroConfigTs,
      "app/v1/package.json.tmpl": astroStarlightAppV1PackageJson,
      "app/v1/src/content/docs/index.md.tmpl":
        astroStarlightAppV1SrcContentDocsIndexMd,
      "app/v1/src/content.config.ts.tmpl":
        astroStarlightAppV1SrcContentConfigTs,
      "app/v1/src/prepared.ts.tmpl": astroStarlightAppV1SrcPreparedTs,
      "app/v1/tests/docs.test.ts.tmpl": astroStarlightAppV1TestsDocsTestTs,
      "app/v1/tsconfig.json.tmpl": astroStarlightAppV1TsconfigJson,
    }),
    "bun-service": layer({
      "README.md.tmpl": bunServiceReadmeMd,
      "app/v1/package.json.tmpl": bunServiceAppV1PackageJson,
      "app/v1/src/app.test.ts.tmpl": bunServiceAppV1SrcAppTestTs,
      "app/v1/src/app.ts.tmpl": bunServiceAppV1SrcAppTs,
      "app/v1/src/server.ts.tmpl": bunServiceAppV1SrcServerTs,
      "app/v1/tsconfig.json.tmpl": bunServiceAppV1TsconfigJson,
    }),
    "python-uv": layer({
      "README.md.tmpl": pythonUvReadmeMd,
      "app/v1/package.json.tmpl": pythonUvAppV1PackageJson,
      "app/v1/pyproject.toml.tmpl": pythonUvAppV1PyprojectToml,
      "app/v1/src/{{python_package}}/__init__.py.tmpl":
        pythonUvAppV1SrcPackageInitPy,
      "app/v1/src/{{python_package}}/py.typed.tmpl":
        pythonUvAppV1SrcPackagePyTyped,
      "app/v1/src/{{python_package}}/server.py.tmpl":
        pythonUvAppV1SrcPackageServerPy,
      "app/v1/tests/test_server.py.tmpl": pythonUvAppV1TestsTestServerPy,
      "dot-github/workflows/check.yml.tmpl": pythonUvDotGithubWorkflowsCheckYml,
    }),
    none: layer({
      "README.md.tmpl": noneReadmeMd,
    }),
  }),
});
