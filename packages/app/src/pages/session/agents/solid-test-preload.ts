import solidPlugin from "vite-plugin-solid"

interface SolidCompiler {
  transform(source: string, id: string, options: { ssr: boolean }): Promise<{ code?: string } | null>
}

function isSolidCompiler(value: unknown): value is SolidCompiler {
  return typeof value === "object" && value !== null && "transform" in value && typeof value.transform === "function"
}

const compiler: unknown = solidPlugin({ hot: false })
if (!isSolidCompiler(compiler)) throw new Error("Unable to initialize the Solid test compiler")

// Bun resolves the client runtime but does not apply Vite's Solid JSX transform during tests.
Bun.plugin({
  name: "agents-solid-tests",
  setup(build) {
    build.onLoad({ filter: /packages\/(?:app|ui)\/src\/.*\.tsx$/ }, async (args) => {
      const result = await compiler.transform(await Bun.file(args.path).text(), args.path, { ssr: false })
      if (!result?.code) throw new Error(`Unable to compile Solid test module: ${args.path}`)
      return { contents: result.code, loader: "ts" }
    })
  },
})
