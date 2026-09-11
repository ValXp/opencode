import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const source = await Bun.file(new URL("./deploy-local.sh", import.meta.url)).text()

for (const scenario of ["success", "smoke", "startup", "preflight", "error", "tool", "incomplete", "schedule"]) {
  test.skipIf(process.platform !== "linux")(`local deployment: ${scenario}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-test-"))
    try {
      await mkdir(`${dir}/bin`)
      await mkdir(`${dir}/proc/101`, { recursive: true })
      await mkdir(`${dir}/proc/102`, { recursive: true })
      const candidate = `#!/bin/bash
printf '%s\\n' "$@" > '${dir}/args'
[[ ! -t 0 ]]
printf '%s\\n' '{"type":"text","sessionID":"fresh","part":{"text":"${scenario === "smoke" ? "WRONG" : "DEPLOY_SMOKE_OK"}"}}'
${scenario === "incomplete" ? "" : `printf '%s\\n' '{"type":"step_finish","sessionID":"fresh","part":{"reason":"stop"}}'`}
${["error", "tool"].includes(scenario) ? `printf '%s\\n' '{"type":"${scenario === "tool" ? "tool_use" : "error"}","sessionID":"fresh"}'` : ""}
`
      await writeFile(`${dir}/target`, candidate, { mode: 0o755 })
      await writeFile(`${dir}/proc/101/exe`, "old deleted executable")
      await writeFile(`${dir}/pid`, "101")
      await writeFile(
        `${dir}/deploy.sh`,
        source
          .replace("target=/root/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode", `target=${dir}/target`)
          .replace("backups=/root/opencode-rollback", `backups=${dir}/backups`)
          .replaceAll("/proc/", `${dir}/proc/`),
      )
      const commands = {
        systemctl: `[[ "$*" != *--user* ]] || exit 99
if [[ $1 == restart ]]; then
  printf 'restart\\n' >> '${dir}/restarts'
  ${scenario === "startup" ? `[[ -f '${dir}/failed' ]] || { touch '${dir}/failed'; exit 1; }` : ""}
  cp '${dir}/target' '${dir}/proc/102/exe'
  printf 102 > '${dir}/pid'
  exit 0
fi
[[ $1 == is-active ]] && exit 0
case "$*" in
  *"--property=MainPID --value") /bin/cat '${dir}/pid';;
  *"--property=ExecMainStartTimestamp --value") printf 'start-time';;
  *) printf 'MainPID=101\\nExecMainStartTimestamp=start-time\\n';;
esac`,
        readlink: `[[ $1 == -f ]] && { printf '%s\\n' "$2"; exit; }
if [[ $1 == */101/exe ]]; then
  printf '%s\\n' '${scenario === "preflight" ? "/wrong/path" : `${dir}/target (deleted)`}'
  exit
fi
printf '%s\\n' '${dir}/target'`,
        curl: `printf '%s\\n' '{"healthy":true}'`,
        "systemd-run": `printf '%s\\n' "$@" > '${dir}/scheduled'`,
      }
      for (const [name, body] of Object.entries(commands)) {
        await writeFile(`${dir}/bin/${name}`, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
      }
      const result = Bun.spawnSync(["bash", `${dir}/deploy.sh`, ...(scenario === "schedule" ? [] : ["--run"])], {
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      })
      if (scenario === "schedule") {
        expect(result.exitCode).toBe(0)
        const scheduled = await readFile(`${dir}/scheduled`, "utf8")
        expect(scheduled).toContain("--on-active=15s")
        expect(scheduled).toContain("--run")
        expect(scheduled).not.toContain("--user")
        expect(await Bun.file(`${dir}/restarts`).exists()).toBe(false)
        return
      }
      const runs = (await readdir(`${dir}/backups`)).filter((name) => name !== "deploy.lock")
      const run = `${dir}/backups/${runs[0]}`
      const log = await readFile(`${run}/deploy.log`, "utf8")
      expect(result.exitCode, log).toBe(scenario === "success" ? 0 : 1)
      expect(await readFile(`${dir}/target`, "utf8")).toBe(
        ["success", "preflight"].includes(scenario) ? candidate : "old deleted executable",
      )
      if (scenario === "preflight") {
        expect(await Bun.file(`${dir}/restarts`).exists()).toBe(false)
        expect(log).not.toContain("restoring")
        return
      }
      expect(await readFile(`${run}/previous`, "utf8")).toBe("old deleted executable")
      expect(await readFile(`${run}/candidate`, "utf8")).toBe(candidate)
      expect(await readFile(`${run}/before.txt`, "utf8")).toContain("ExecMainStartTimestamp")
      expect((await readFile(`${dir}/restarts`, "utf8")).trim().split("\n")).toHaveLength(
        scenario === "success" ? 1 : 2,
      )
      expect(log).toContain(scenario === "success" ? "Deployment verified" : "Rollback verified")
      if (scenario !== "startup") {
        expect((await readFile(`${dir}/args`, "utf8")).trim().split("\n")).toEqual([
          "run",
          "--attach",
          "http://127.0.0.1:80",
          "--dir",
          "/root",
          "--format",
          "json",
          "--title",
          "deploy-smoke",
          "Do not use tools. Reply with exactly DEPLOY_SMOKE_OK and nothing else.",
        ])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
