import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const source = await Bun.file(new URL("./deploy-local.sh", import.meta.url)).text()
const smokePrompt = "Do not use tools. Reply with exactly DEPLOY_SMOKE_OK and nothing else."
const smokeSession = 'ses_fresh"/ ?#%'

for (const scenario of [
  "success",
  "stream-tail",
  "stream-exit",
  "stream-empty",
  "stream-malformed",
  "stream-session",
  "startup",
  "preflight",
  "error",
  "tool",
  "transcript-error",
  "transcript-tool",
  "transcript-wrong",
  "transcript-partial",
  "transcript-missing-stop",
  "transcript-malformed",
  "transcript-parent",
  "transcript-extra",
  "schedule",
  "schedule-callback",
  "callback",
  "callback-failure",
  "callback-rollback",
  "transient",
  "transient-callback-rollback",
  "callback-delayed",
  "callback-unreachable",
  "callback-failed-rollback",
  "user",
  "user-rollback",
  "invalid",
]) {
  test.skipIf(process.platform !== "linux")(`local deployment: ${scenario}`, async () => {
    const user = ["schedule-callback", "user", "user-rollback"].includes(scenario)
    const callback = scenario.includes("callback") || scenario.startsWith("user")
    const rollback = scenario.endsWith("rollback")
    const success = [
      "success",
      "callback",
      "callback-failure",
      "user",
      "transient",
      "stream-tail",
      "callback-delayed",
      "callback-unreachable",
    ].includes(scenario)
    const session = 'ses_quoted"/ ?#%'
    const directory = '/workspace/a "quote" & 日本語\nnext'
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-test-"))
    try {
      await mkdir(`${dir}/bin`)
      await mkdir(`${dir}/proc/101`, { recursive: true })
      await mkdir(`${dir}/proc/102`, { recursive: true })
      const userID = "msg_smoke_user"
      const assistantID = "msg_smoke_assistant"
      const transcript = [
        {
          info: {
            id: userID,
            sessionID: smokeSession,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "test", modelID: "smoke" },
          },
          parts: [
            {
              id: "prt_smoke_user",
              sessionID: smokeSession,
              messageID: userID,
              type: "text",
              text: `"${smokePrompt}"`,
            },
          ],
        },
        {
          info: {
            id: assistantID,
            sessionID: smokeSession,
            role: "assistant",
            time: { created: 2, completed: 3 },
            ...(scenario === "transcript-error"
              ? { error: { name: "UnknownError", data: { message: "smoke failed" } } }
              : {}),
            parentID: scenario === "transcript-parent" ? "msg_wrong_parent" : userID,
            modelID: "smoke",
            providerID: "test",
            mode: "build",
            agent: "build",
            path: { cwd: "/root", root: "/" },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
          parts: [
            {
              id: "prt_smoke_start",
              sessionID: smokeSession,
              messageID: assistantID,
              type: "step-start",
            },
            ...(scenario === "transcript-partial"
              ? [
                  {
                    id: "prt_smoke_text_1",
                    sessionID: smokeSession,
                    messageID: assistantID,
                    type: "text",
                    text: "DEPLOY_SMOKE_",
                    time: { start: 2, end: 3 },
                  },
                  {
                    id: "prt_smoke_text_2",
                    sessionID: smokeSession,
                    messageID: assistantID,
                    type: "text",
                    text: "OK",
                    time: { start: 2, end: 3 },
                  },
                ]
              : [
                  {
                    id: "prt_smoke_text",
                    sessionID: smokeSession,
                    messageID: assistantID,
                    type: "text",
                    text: scenario === "transcript-wrong" || rollback ? "WRONG" : "DEPLOY_SMOKE_OK",
                    time: { start: 2, end: 3 },
                  },
                ]),
            ...(scenario === "transcript-tool"
              ? [
                  {
                    id: "prt_smoke_tool",
                    sessionID: smokeSession,
                    messageID: assistantID,
                    type: "tool",
                    callID: "call_smoke",
                    tool: "bash",
                    state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 2, end: 3 } },
                  },
                ]
              : []),
            ...(scenario === "transcript-missing-stop"
              ? []
              : [
                  {
                    id: "prt_smoke_finish",
                    sessionID: smokeSession,
                    messageID: assistantID,
                    type: "step-finish",
                    reason: "stop",
                    cost: 0,
                    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                  },
                ]),
          ],
        },
        ...(scenario === "transcript-extra"
          ? [
              {
                info: {
                  id: "msg_stale",
                  sessionID: smokeSession,
                  role: "user",
                  time: { created: 0 },
                  agent: "build",
                  model: { providerID: "test", modelID: "smoke" },
                },
                parts: [
                  {
                    id: "prt_stale",
                    sessionID: smokeSession,
                    messageID: "msg_stale",
                    type: "text",
                    text: "stale",
                  },
                ],
              },
            ]
          : []),
      ]
      const transcriptBody =
        scenario === "transcript-malformed" ? JSON.stringify({ messages: transcript }) : JSON.stringify(transcript)
      const stream = (() => {
        if (scenario === "stream-empty") return []
        if (scenario === "stream-malformed") return ["not-json"]
        return [
          JSON.stringify({
            type: "step_start",
            sessionID: smokeSession,
            part: { type: "step-start" },
          }),
          JSON.stringify({
            type: "text",
            sessionID: smokeSession,
            part: { type: "text", text: "DEPLOY_SMOKE_OK" },
          }),
          ...(scenario === "stream-tail"
            ? []
            : [
                JSON.stringify({
                  type: "step_finish",
                  sessionID: scenario === "stream-session" ? "ses_other" : smokeSession,
                  part: { type: "step-finish", reason: "stop" },
                }),
              ]),
          ...(["error", "tool"].includes(scenario)
            ? [JSON.stringify({ type: scenario === "tool" ? "tool_use" : "error", sessionID: smokeSession })]
            : []),
        ]
      })()
      const candidate = `#!/bin/bash
printf '%s\\n' "$@" > '${dir}/args'
[[ ! -t 0 ]]
${stream.map((line) => `printf '%s\\n' '${line}'`).join("\n")}
${scenario === "stream-exit" ? "exit 17" : ""}
`
      await writeFile(`${dir}/target`, candidate, { mode: 0o755 })
      await writeFile(`${dir}/proc/101/exe`, "old deleted executable")
      await writeFile(`${dir}/pid`, "101")
      await writeFile(
        `${dir}/deploy.sh`,
        source
          .replace(
            "target=/root/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode",
            `target=${dir}/target`,
          )
          .replace("backups=/root/opencode-rollback", `backups=${dir}/backups`)
          .replaceAll("/proc/", `${dir}/proc/`),
      )
      const commands = {
        systemctl: `${user ? "[[ $1 == --user ]] || exit 99; shift" : '[[ "$*" != *--user* ]] || exit 99'}
if [[ $1 == restart ]]; then
  printf 'restart\\n' >> '${dir}/restarts'
  printf 0 > '${dir}/check'
  ${scenario === "startup" ? `[[ -f '${dir}/failed' ]] || { touch '${dir}/failed'; exit 1; }` : ""}
  cp '${dir}/target' '${dir}/proc/102/exe'
  printf 102 > '${dir}/pid'
  exit 0
fi
${scenario.startsWith("transient") ? `
if [[ -f '${dir}/restarts' ]]; then
  n=$(/bin/cat '${dir}/check' 2>/dev/null || printf 0)
  if [[ "$*" == *'--property=MainPID --value'* ]]; then
    n=$((n+1)); printf '%s' "$n" > '${dir}/check'
    [[ $n != 1 ]] || exit 1
    [[ $n != 2 ]] || { printf 0; exit; }
  fi
  [[ $1 != is-active || $n != 3 ]] || exit 1
fi` : ""}
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
${scenario.startsWith("transient") ? `
n=$(/bin/cat '${dir}/check')
[[ $n != 4 ]] || exit 1
[[ $n != 5 ]] || { printf /wrong/path; exit; }` : ""}
printf '%s\\n' '${dir}/target'`,
        curl: `if [[ "$*" == *'/message?directory='* ]]; then
  printf '%s\\0' "$@" > '${dir}/smoke-request'
  output=
  while (( $# )); do
    if [[ $1 == --output ]]; then output=$2; break; fi
    shift
  done
  [[ -n $output ]]
  printf '%s\\n' '${transcriptBody}' > "$output"
  exit 0
fi
if [[ "$*" == *prompt_async* ]]; then
  ${scenario === "callback-delayed" ? `[[ $(/bin/cat '${dir}/health') == 6 ]] || exit 99` : ""}
  ${scenario === "callback-failed-rollback" ? `[[ $(/bin/cat '${dir}/health') == 4 ]] || exit 99` : ""}
  printf '%s\\0' "$@" >> '${dir}/callback'
  exit ${scenario === "callback-failure" ? 22 : 0}
fi
${scenario === "callback-failed-rollback" ? `
n=$(/bin/cat '${dir}/health' 2>/dev/null || printf 0)
n=$((n+1)); printf '%s' "$n" > '${dir}/health'
(( n > 3 )) || exit 7` : ""}
${scenario.startsWith("transient") ? `[[ $(/bin/cat '${dir}/check') != 8 ]] || exit 7` : ""}
${["callback-delayed", "callback-unreachable"].includes(scenario) ? `
n=$(/bin/cat '${dir}/health' 2>/dev/null || printf 0)
n=$((n+1)); printf '%s' "$n" > '${dir}/health'
if (( n > 2 )); then
  ${scenario === "callback-unreachable" ? "exit 7" : "(( n > 5 )) || exit 7"}
fi` : ""}
printf '%s\\n' '{"healthy":true}'`,
        sleep: `printf 'sleep\\n' >> '${dir}/sleeps'`,
        sha256sum: `${scenario.startsWith("transient") ? `
if [[ $1 == */102/exe ]]; then
  n=$(/bin/cat '${dir}/check')
  [[ $n != 6 ]] || exit 1
  [[ $n != 7 ]] || { printf 'wrong  %s\\n' "$1"; exit; }
fi` : ""}
${scenario === "callback-failed-rollback" ? `[[ $1 != */102/exe ]] || { printf 'wrong  %s\\n' "$1"; exit; }` : ""}
exec /usr/bin/sha256sum "$@"`,
        "systemd-run": `printf '%s\\n' "$@" > '${dir}/scheduled'`,
      }
      for (const [name, body] of Object.entries(commands)) {
        await writeFile(`${dir}/bin/${name}`, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
      }
      if (scenario === "invalid") {
        for (const args of [
          ["--unknown"],
          ["--session"],
          ["--directory"],
          ["--session", ""],
          ["--session", "s"],
          ["--directory", "/root"],
          ["--session", "--user"],
          ["--user", "--user"],
          ["--run", "--run"],
          ["--session", "s", "--session", "s", "--directory", "/root"],
          ["--directory", "/root", "--directory", "/root", "--session", "s"],
        ]) {
          const result = Bun.spawnSync(["bash", `${dir}/deploy.sh`, ...args], {
            env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
          })
          expect(result.exitCode).toBe(2)
          expect(result.stderr.toString()).toContain("Usage:")
        }
        expect(await Bun.file(`${dir}/scheduled`).exists()).toBe(false)
        expect(await Bun.file(`${dir}/backups/deploy.lock`).exists()).toBe(false)
        return
      }
      const args = [...(user ? ["--user"] : []), ...(callback ? ["--session", session, "--directory", directory] : [])]
      const result = Bun.spawnSync(
        ["bash", `${dir}/deploy.sh`, ...(scenario.startsWith("schedule") ? [] : ["--run"]), ...args],
        {
          env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
        },
      )
      if (scenario.startsWith("schedule")) {
        expect(result.exitCode).toBe(0)
        const scheduled = await readFile(`${dir}/scheduled`, "utf8")
        expect(scheduled).toContain("--on-active=15s")
        expect(scheduled).toContain("--run")
        if (user) expect(scheduled).toStartWith("--user\n")
        else expect(scheduled).not.toContain("--user")
        expect(scheduled).toEndWith(["--run", ...args, ""].join("\n"))
        expect(await Bun.file(`${dir}/restarts`).exists()).toBe(false)
        return
      }
      const runs = (await readdir(`${dir}/backups`)).filter((name) => name !== "deploy.lock")
      const run = `${dir}/backups/${runs[0]}`
      const log = await readFile(`${run}/deploy.log`, "utf8")
      if (success) expect(result.exitCode, log).toBe(0)
      else expect(result.exitCode, log).not.toBe(0)
      const transcriptExpected = ![
        "startup",
        "preflight",
        "stream-exit",
        "stream-empty",
        "stream-malformed",
        "stream-session",
        "error",
        "tool",
        "callback-failed-rollback",
      ].includes(scenario)
      if (transcriptExpected) {
        const request = (await readFile(`${dir}/smoke-request`, "utf8")).split("\0").slice(0, -1)
        expect(request[request.indexOf("--connect-timeout") + 1]).toBe("5")
        expect(request[request.indexOf("--max-time") + 1]).toBe("15")
        expect(request[request.indexOf("--output") + 1]).toBe(`${run}/smoke.messages.json`)
        expect(request.at(-1)).toBe(
          `http://127.0.0.1:80/session/${encodeURIComponent(smokeSession)}/message?directory=%2Froot`,
        )
        expect(await readFile(`${run}/smoke.messages.json`, "utf8")).toBe(`${transcriptBody}\n`)
      } else {
        expect(await Bun.file(`${dir}/smoke-request`).exists()).toBe(false)
        expect(await Bun.file(`${run}/smoke.messages.json`).exists()).toBe(false)
      }
      if (scenario === "callback-unreachable") {
        expect(await Bun.file(`${dir}/callback`).exists()).toBe(false)
        expect(await readFile(`${dir}/health`, "utf8")).toBe("32")
        expect(log).toContain("API readiness exhausted 30 attempts")
        expect(log).toContain("deployment result unchanged")
      } else if (callback) {
        const request = (await readFile(`${dir}/callback`, "utf8")).split("\0").slice(0, -1)
        expect(request.filter((arg) => arg === "POST")).toHaveLength(1)
        expect(request[request.indexOf("--connect-timeout") + 1]).toBe("5")
        expect(request[request.indexOf("--max-time") + 1]).toBe("15")
        expect(request).toContain("Content-Type: application/json")
        expect(request.at(-1)).toBe(
          `http://127.0.0.1:80/session/${encodeURIComponent(session)}/prompt_async?directory=${encodeURIComponent(directory)}`,
        )
        expect(JSON.parse(request[request.indexOf("--data-binary") + 1]!)).toEqual({
          parts: [
            {
              type: "text",
              text: `${scenario === "callback-failed-rollback" ? "Deployment failed; ROLLBACK FAILED: manual recovery required." : rollback ? "Deployment failed; rollback verified (binary and health)." : "Deployment verified: fresh default-model session completed."} Artifacts: ${run}`,
            },
          ],
        })
        expect(log).toContain(
          scenario === "callback-failure"
            ? "Completion callback FAILED; deployment result unchanged; no retry."
            : "Completion callback POST succeeded (receipt not verified).",
        )
      } else expect(await Bun.file(`${dir}/callback`).exists()).toBe(false)
      if (scenario === "callback-delayed") expect(await readFile(`${dir}/health`, "utf8")).toBe("6")
      if (scenario.startsWith("transient")) {
        expect(await readFile(`${dir}/check`, "utf8")).toBe(rollback ? "9" : "10")
        expect((await readFile(`${dir}/sleeps`, "utf8")).trim().split("\n")).toHaveLength(rollback ? 16 : 8)
      }
      expect(await readFile(`${dir}/target`, "utf8")).toBe(
        success || scenario === "preflight" ? candidate : "old deleted executable",
      )
      if (scenario === "preflight") {
        expect(await Bun.file(`${dir}/restarts`).exists()).toBe(false)
        expect(log).not.toContain("restoring")
        return
      }
      expect(await readFile(`${run}/previous`, "utf8")).toBe("old deleted executable")
      expect(await readFile(`${run}/candidate`, "utf8")).toBe(candidate)
      expect(await readFile(`${run}/before.txt`, "utf8")).toContain("ExecMainStartTimestamp")
      expect((await readFile(`${dir}/restarts`, "utf8")).trim().split("\n")).toHaveLength(success ? 1 : 2)
      if (scenario === "callback-failed-rollback") {
        expect(log.match(/Verification exhausted 30 attempts: PID=102 executable hash=wrong; expected=/g)).toHaveLength(2)
        expect(await readFile(`${dir}/health`, "utf8")).toBe("4")
        expect((await readFile(`${dir}/sleeps`, "utf8")).trim().split("\n")).toHaveLength(61)
        expect(await Bun.file(`${dir}/args`).exists()).toBe(false)
        return
      }
      expect(log).toContain(success ? "Deployment verified" : "Rollback verified")
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
